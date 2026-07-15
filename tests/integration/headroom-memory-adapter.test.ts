/**
 * HeadroomMemorySidecar lifecycle + fail-open (R3.6), tested against a fake
 * worker (Node) that speaks the worker protocol — so no Python/uv/torch is
 * needed in CI. Mirrors headroom-adapter.test.ts's coverage for the
 * compression sidecar.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { HeadroomMemorySidecar } from "../../src/compression/headroom-adapter.js";

const FAKE_WORKER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "fake-headroom-memory-worker.mjs",
);

/** A sidecar that launches the fake worker via `node <fake>` instead of uv/python. */
function fakeSidecar(
  env: Record<string, string> = {},
  startupTimeoutMs = 8000,
): HeadroomMemorySidecar {
  return new HeadroomMemorySidecar({
    command: process.execPath, // node
    launchArgs: [],
    workerPath: FAKE_WORKER,
    startupTimeoutMs,
    requestTimeoutMs: 5000,
    log: () => {}, // silence
    ...applyEnv(env),
  });
}

/** Set env vars the fake worker reads; return {} so it merges cleanly into options. */
function applyEnv(env: Record<string, string>): Record<string, never> {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return {};
}

const sidecars: HeadroomMemorySidecar[] = [];
function track(s: HeadroomMemorySidecar): HeadroomMemorySidecar {
  sidecars.push(s);
  return s;
}

afterEach(() => {
  for (const s of sidecars.splice(0)) s.stop();
  process.env.FAKE_MODE = undefined as unknown as string;
  delete process.env.FAKE_MODE;
});

describe("HeadroomMemorySidecar (fake worker)", () => {
  it("starts, health-checks, searches, and returns parsed facts", async () => {
    const sc = track(fakeSidecar());
    expect(await sc.start()).toBe(true);
    expect(sc.isRunning()).toBe(true);

    const facts = await sc.search("what did we decide about auth", "proj-1", 5);
    expect(facts).not.toBeNull();
    expect(facts).toHaveLength(1);
    expect(facts?.[0]?.id).toBe("fact-1");
    expect(facts?.[0]?.content).toContain("proj-1");
    expect(facts?.[0]?.score).toBe(0.87);
    expect(facts?.[0]?.metadata).toEqual({ source: "fake" });
  });

  it("lazily starts on first search() when start() was not called", async () => {
    const sc = track(fakeSidecar());
    const facts = await sc.search("x", "proj-1", 5);
    expect(facts).not.toBeNull();
    expect(sc.isRunning()).toBe(true);
  });

  it("fails open (null) when the launcher command does not exist", async () => {
    const sc = track(
      new HeadroomMemorySidecar({
        command: "definitely-not-a-real-command-xyz",
        launchArgs: [],
        workerPath: FAKE_WORKER,
        startupTimeoutMs: 3000,
        log: () => {},
      }),
    );
    expect(await sc.start()).toBe(false);
    expect(await sc.search("x", "proj-1", 5)).toBeNull();
    expect(sc.isRunning()).toBe(false);
  });

  it("fails open (null) when the worker returns a non-200 on /memory/search", async () => {
    const sc = track(fakeSidecar({ FAKE_MODE: "badstatus" }));
    expect(await sc.start()).toBe(true);
    expect(await sc.search("x", "proj-1", 5)).toBeNull();
  });

  it("fails open (false) when the worker never announces a port (startup timeout)", async () => {
    const sc = track(fakeSidecar({ FAKE_MODE: "slowstart" }, 1200));
    expect(await sc.start()).toBe(false);
  });

  it("fails open (false) when the worker announces a port but never passes the health check", async () => {
    const sc = track(fakeSidecar({ FAKE_MODE: "unhealthy" }));
    expect(await sc.start()).toBe(false);
    expect(sc.isRunning()).toBe(false);
  });
});
