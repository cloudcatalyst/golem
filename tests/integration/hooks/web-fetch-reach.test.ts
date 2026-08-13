/**
 * R9.19 — the §125 mismatch, simulated end to end.
 *
 * The brief says this cannot be reproduced from a terminal session, and that the
 * options are to simulate the mismatch or verify in a real Desktop-app-managed
 * session. This simulates it, and the simulation is faithful to what actually
 * differs: signals 1–3 of `greenServeState` all read THIS process's environment, so
 * they are made to pass for real — a real loopback endpoint, the real CA on disk,
 * `NODE_EXTRA_CA_CERTS` naming it, a real TLS probe that succeeds.
 *
 * What a cloud/Desktop session changes is not any of that. It is whether Claude
 * Code's own TLS stack honours the CA, and therefore whether the rewritten fetch
 * ever lands on `/w`. So the mismatch is reproduced by leaving `/w` un-hit: the hook
 * believes everything it can see, and the evidence never arrives.
 *
 * The trusted case is the same setup with the `/w` request actually made.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { greenServeState } from "../../../src/hooks/web-fetch/serve.js";
import { generateLoopbackPair } from "../../../src/proxy/loopback-cert.js";
import { readLoopbackHits, readLoopbackReach } from "../../../src/proxy/loopback-reach.js";
import {
  type LoopbackServeHandle,
  loopbackServeUrl,
  readLoopbackServeState,
  startLoopbackServe,
} from "../../../src/proxy/loopback-serve.js";
import { rmTemp } from "../../helpers/tmp.js";

let root: string;
let projectDir: string;
let handle: LoopbackServeHandle;
let caPath: string;
let caPem: string;
let previousCa: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "golem-reach-"));
  projectDir = path.join(root, "project");
  await mkdir(projectDir, { recursive: true });

  const pair = await generateLoopbackPair();
  caPath = path.join(projectDir, "ca.pem");
  caPem = pair.caPem;
  await writeFile(caPath, pair.caPem, "utf8");
  handle = await startLoopbackServe({
    projectDir,
    certPem: pair.chainPem,
    keyPem: pair.leafKeyPem,
    certPath: caPath,
  });
  // Signals 1–3 must genuinely pass, exactly as they do in the failing session.
  previousCa = process.env.NODE_EXTRA_CA_CERTS;
  process.env.NODE_EXTRA_CA_CERTS = caPath;
});

afterEach(async () => {
  if (previousCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
  else process.env.NODE_EXTRA_CA_CERTS = previousCa;
  await handle.close();
  await rm(root, rmTemp).catch(() => {});
});

const errSink = (): { write(s: string): void; lines: string[] } => {
  const lines: string[] = [];
  return { write: (s: string) => void lines.push(s), lines };
};

/**
 * Wait for the endpoint's hit record to land.
 *
 * The endpoint writes it fire-and-forget on purpose — recording evidence must never
 * delay or fail a serve — so it is not durable the instant the HTTP response ends.
 * Polling here matches production behaviour instead of forcing the server to await
 * a state write on the serve path.
 */
async function waitForHit(deadlineMs = 5_000): Promise<number> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    const hits = await readLoopbackHits(projectDir);
    if (hits !== null && hits.count > 0) return hits.count;
    await new Promise((r) => setTimeout(r, 20));
  }
  return 0;
}

/** Follow a rewritten URL for real — what Claude Code does when it trusts the CA. */
async function followRewrite(url: string): Promise<number> {
  const target = new URL(url);
  return new Promise<number>((resolve, reject) => {
    const req = httpsRequest(
      {
        host: target.hostname,
        port: Number(target.port),
        path: `${target.pathname}${target.search}`,
        ca: caPem,
        rejectUnauthorized: true,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("green-path reachability latch (R9.19)", () => {
  it("a session whose rewrites are never followed goes green ONCE, then floors", async () => {
    const err = errSink();

    // Fetch 1 — nothing is known yet, so the rewrite happens optimistically. This
    // is the single WebFetch that renders as a TLS error in such a session.
    expect(await greenServeState(projectDir, { stderr: err })).not.toBeNull();
    expect((await readLoopbackReach(projectDir))?.verdict).toBe("unknown");
    expect(await readLoopbackHits(projectDir)).toBeNull(); // the rewrite was NOT followed

    // Fetch 2 — the attempt produced no hit, so the verdict settles and the floor
    // takes over. This is the assertion the gate is written around.
    expect(await greenServeState(projectDir, { stderr: err })).toBeNull();
    expect((await readLoopbackReach(projectDir))?.verdict).toBe("untrusted");

    // Every later fetch in the window: still the floor, no further TLS errors.
    for (let i = 0; i < 3; i++) {
      expect(await greenServeState(projectDir, { stderr: err })).toBeNull();
    }

    // And the decision is visible — an invisible trust verdict is undebuggable.
    expect(err.lines.join("")).toContain("never reached the endpoint");
  });

  it("a session that DOES follow the rewrite is green on the first fetch and stays green", async () => {
    const err = errSink();

    // Fetch 1: green, optimistically.
    const first = await greenServeState(projectDir, { stderr: err });
    expect(first).not.toBeNull();

    // Claude Code trusts the CA here, so the rewritten URL is actually fetched.
    const state = await readLoopbackServeState(projectDir);
    expect(state).not.toBeNull();
    if (state === null) throw new Error("expected published endpoint state");
    const status = await followRewrite(loopbackServeUrl(state, "https://example.com/x", "hit"));
    expect(status).toBe(200);
    // The endpoint recorded the evidence the hook cannot get from its own env.
    expect(await waitForHit()).toBeGreaterThanOrEqual(1);

    // Fetch 2 onwards: promoted to trusted, and green from here on.
    expect(await greenServeState(projectDir, { stderr: err })).not.toBeNull();
    expect((await readLoopbackReach(projectDir))?.verdict).toBe("trusted");
    for (let i = 0; i < 3; i++) {
      expect(await greenServeState(projectDir, { stderr: err })).not.toBeNull();
    }
    expect(err.lines.join("")).toContain("reached the endpoint");
  });

  it("an endpoint restart re-probes instead of inheriting a stale verdict", async () => {
    // Latch to untrusted first.
    await greenServeState(projectDir);
    expect(await greenServeState(projectDir)).toBeNull();
    expect((await readLoopbackReach(projectDir))?.verdict).toBe("untrusted");

    // Restart the endpoint: a new `startedAt`, possibly a new CA. The old verdict
    // describes a server that no longer exists.
    await handle.close();
    const pair = await generateLoopbackPair();
    await writeFile(caPath, pair.caPem, "utf8");
    caPem = pair.caPem;
    handle = await startLoopbackServe({
      projectDir,
      certPem: pair.chainPem,
      keyPem: pair.leafKeyPem,
      certPath: caPath,
    });

    // Optimistic again, rather than floored on the previous instance's evidence.
    expect(await greenServeState(projectDir)).not.toBeNull();
    expect((await readLoopbackReach(projectDir))?.verdict).toBe("unknown");
  });

  it("still fails closed when the CA is not ours, latch or no latch", async () => {
    // The R9.12 signals keep primacy: the latch can only ever take green AWAY, it
    // can never grant it to a session that failed an earlier check.
    process.env.NODE_EXTRA_CA_CERTS = path.join(projectDir, "someone-elses.pem");
    expect(await greenServeState(projectDir)).toBeNull();
    // And it recorded no optimistic attempt, because it never got that far.
    expect(await readLoopbackReach(projectDir)).toBeNull();
  });
});
