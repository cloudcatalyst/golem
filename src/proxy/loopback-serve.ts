/**
 * The loopback stub endpoint (R9.12; verification-notes §122).
 *
 * WebFetch renders a hook `deny` as a failed tool call, so the only way a
 * cache-served fetch shows GREEN is to let the tool actually run against a URL
 * Golem controls (`updatedInput` + `allow`). WebFetch forces `http`→`https` and
 * validates the certificate, so that URL must be HTTPS on `127.0.0.1` behind the
 * leaf in {@link ../proxy/loopback-cert.js}.
 *
 * Crucially this endpoint serves a **stub**, never the page. §122 measured that
 * `additionalContext` reaches the model on an `allow` decision, so the raw
 * cached text travels there — prompt-independent and un-summarized, preserving
 * Decision 42 — while WebFetch's per-fetch summarizer only ever sees a few
 * hundred bytes of placeholder. Serving the page here instead would hand the
 * model a prompt-specific summary of a truncated page, which is the fidelity
 * regression §120 rightly refused.
 *
 * Any process on the machine can reach a loopback port, so every request must
 * carry the per-run nonce; without it the endpoint 404s and reveals nothing.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, get as httpsGet, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { z } from "zod";
import { recordLoopbackHit } from "./loopback-reach.js";

/** `.golem/state/loopback-serve.json` — how the hook finds a running endpoint. */
export function loopbackServeStatePath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "loopback-serve.json");
}

const stateSchema = z.object({
  port: z.number().int().positive(),
  nonce: z.string().min(16),
  certPath: z.string().min(1),
  pid: z.number().int().positive(),
  startedAt: z.string(),
});

export type LoopbackServeState = z.infer<typeof stateSchema>;

/** Read the running endpoint's coordinates; null when absent or malformed. */
export async function readLoopbackServeState(
  projectDir: string,
): Promise<LoopbackServeState | null> {
  try {
    const raw = await readFile(loopbackServeStatePath(projectDir), "utf8");
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = stateSchema.safeParse(JSON.parse(stripped));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writeState(projectDir: string, state: LoopbackServeState): Promise<void> {
  const file = loopbackServeStatePath(projectDir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

/** Length-safe constant-time compare (timingSafeEqual throws on length mismatch). */
function nonceMatches(expected: string, provided: string | null): boolean {
  if (provided === null) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The placeholder body. WebFetch runs its summarizer over THIS, so it must be
 * short, and it must tell the summarizer plainly that the page is elsewhere —
 * otherwise the tool result reads as an empty or broken page.
 */
export function stubBody(url: string): string {
  // Wording matters and was measured: an earlier draft said only "placeholder,
  // no page text here", and the model reported the fetch as having ERRORED even
  // though it returned 200 — which invites a pointless retry. Say plainly that
  // the fetch succeeded and that the content is elsewhere.
  return [
    "Golem cache-serve placeholder — THE FETCH SUCCEEDED.",
    "",
    `Requested URL: ${url}`,
    "",
    "Golem served this URL from its local knowledge base. The page text has",
    "already been delivered directly into the assistant's context alongside this",
    "tool result, so it is deliberately not repeated here. Nothing failed, and",
    "there is nothing to retry.",
    "",
    "If you are summarizing this document: state that the fetch succeeded and that",
    "Golem delivered the page content separately. Do not describe this as an error",
    "and do not treat this placeholder as the page itself.",
    "",
  ].join("\n");
}

export interface LoopbackServeHandle {
  readonly port: number;
  readonly nonce: string;
  /** The URL the hook rewrites a WebFetch to. */
  url(targetUrl: string): string;
  close(): Promise<void>;
}

export interface StartLoopbackServeOptions {
  readonly projectDir: string;
  /** leaf + CA chain the server presents. */
  readonly certPem: string;
  readonly keyPem: string;
  /**
   * Path of the **CA** on disk — the anchor. Recorded so the hook can check that
   * `NODE_EXTRA_CA_CERTS` names this exact file before it dares rewrite a URL.
   */
  readonly certPath: string;
  /** Listen port; 0 (default) takes an ephemeral one. */
  readonly port?: number;
  /** Nonce injection point (tests). */
  readonly nonce?: string;
}

/**
 * Start the HTTPS stub endpoint on loopback and publish its coordinates for the
 * hook. Serves exactly two paths, both nonce-gated:
 *   `/health` — the hook's own reachability probe
 *   `/w?u=<url>` — the stub a rewritten WebFetch lands on
 */
export async function startLoopbackServe(
  options: StartLoopbackServeOptions,
): Promise<LoopbackServeHandle> {
  const nonce = options.nonce ?? randomBytes(24).toString("hex");

  const server: Server = createServer(
    { cert: options.certPem, key: options.keyPem },
    (req, res) => {
      // `req.url` is a path+query, so any base works for parsing.
      const parsed = new URL(req.url ?? "/", "https://127.0.0.1");
      if (!nonceMatches(nonce, parsed.searchParams.get("n"))) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found\n");
        return;
      }
      if (parsed.pathname === "/health") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok\n");
        return;
      }
      if (parsed.pathname === "/w") {
        const target = parsed.searchParams.get("u") ?? "(unknown)";
        // R9.19 — the third trust signal. A request landing here is positive proof
        // that a rewritten WebFetch was actually followed, which is the one thing
        // the hook cannot learn from its own environment (§125: the hook's env
        // reflects the settings file, not what Claude Code's TLS stack honours).
        // Fire-and-forget: recording evidence must never delay or fail a serve.
        void recordLoopbackHit(options.projectDir, new Date().toISOString()).catch(() => {});
        const body = stubBody(target);
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          // Never let anything between here and the tool cache this placeholder.
          "cache-control": "no-store",
        });
        res.end(body);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found\n");
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });

  const port = (server.address() as AddressInfo).port;
  await writeState(options.projectDir, {
    port,
    nonce,
    certPath: options.certPath,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  return {
    port,
    nonce,
    url: (targetUrl: string) =>
      `https://127.0.0.1:${port}/w?n=${nonce}&u=${encodeURIComponent(targetUrl)}`,
    close: () =>
      new Promise<void>((resolve) => {
        // `close()` alone waits for in-flight keep-alive sockets to drain, which
        // held the daemon open past shutdown and made `proxy restart` report
        // "did not come up on port 4930" for a proxy that was fine (observed).
        // The endpoint serves stateless stubs, so dropping sockets costs nothing.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Whether a URL is one of our own stubs. Both hooks must recognise it: the pre
 * hook so it never intercepts its own rewrite, and the post hook so it never
 * caches the placeholder *as* the page — which would poison the web cache with
 * a summary of "this is a placeholder".
 */
export function isLoopbackStubUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" && parsed.hostname === "127.0.0.1" && parsed.pathname === "/w"
    );
  } catch {
    return false;
  }
}

/** Where a served page came from — carried on the stub URL so the PostToolUse hook can label it. */
export type ServeSource = "hit" | "miss";

/** Build the rewrite URL from published state (the hook has no handle). */
export function loopbackServeUrl(
  state: LoopbackServeState,
  targetUrl: string,
  source: ServeSource,
  age?: string,
): string {
  // `age` rides along so the labelling hook can say "stored 14h ago" without
  // opening the web cache itself — that hook is on the hot path of every tool
  // call, and it should not pull the knowledge layer in to format one string.
  const ageParam = age === undefined ? "" : `&a=${encodeURIComponent(age)}`;
  return `https://127.0.0.1:${state.port}/w?n=${state.nonce}&s=${source}${ageParam}&u=${encodeURIComponent(targetUrl)}`;
}

/**
 * Read back what {@link loopbackServeUrl} encoded. The PostToolUse hook only
 * sees the rewritten URL, so provenance has to travel on it.
 */
export function parseLoopbackServeUrl(
  url: string,
): { readonly targetUrl: string; readonly source: ServeSource; readonly age?: string } | null {
  try {
    const parsed = new URL(url);
    if (!isLoopbackStubUrl(url)) return null;
    const targetUrl = parsed.searchParams.get("u");
    if (targetUrl === null) return null;
    const raw = parsed.searchParams.get("s");
    const age = parsed.searchParams.get("a");
    return {
      targetUrl,
      source: raw === "miss" ? "miss" : "hit",
      ...(age !== null && age !== "" ? { age } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Positive evidence that the endpoint is up AND its certificate validates —
 * the check §121 asked for instead of assuming. Uses the leaf as its own CA,
 * exactly as `NODE_EXTRA_CA_CERTS` makes Claude Code do. Never throws.
 */
export async function probeLoopbackServe(
  state: LoopbackServeState,
  certPem: string,
  timeoutMs = 1_500,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    try {
      const req = httpsGet(
        {
          host: "127.0.0.1",
          port: state.port,
          path: `/health?n=${state.nonce}`,
          ca: certPem,
          rejectUnauthorized: true,
          timeout: timeoutMs,
        },
        (res) => {
          res.resume(); // drain
          done(res.statusCode === 200);
        },
      );
      req.on("timeout", () => {
        req.destroy();
        done(false);
      });
      req.on("error", () => done(false));
    } catch {
      done(false);
    }
  });
}
