/**
 * R9.19 — the third trust signal: positive evidence that a real WebFetch reached
 * the loopback endpoint.
 *
 * ## The gap this closes
 *
 * R9.12 shipped trust detection with two of its three signals: the endpoint must
 * have published its coordinates, and `NODE_EXTRA_CA_CERTS` in the hook's own
 * environment must name our CA, verified by a TLS probe *from the hook*.
 *
 * Verification-notes §125 then measured that a hook's environment reflects the
 * **settings file**, not necessarily what Claude Code's own TLS stack honours.
 * They happened to agree in a terminal session; §121-A records that they will
 * **not** agree in cloud and Desktop-app-managed sessions, where a repository's
 * settings `env` is ignored for TLS. In such a session all three of R9.12's checks
 * pass, the hook rewrites the URL, and the fetch fails with an opaque TLS error.
 *
 * Nothing is lost — §122 established that `additionalContext` still delivers the
 * page — but the transcript shows a *failure* where the deny floor would have shown
 * Golem's own `NOT AN ERROR —` framing. That is strictly worse in appearance than
 * R9.7, which is the one thing R9.12 promised not to be.
 *
 * ## The mechanism
 *
 * Two small files, each with exactly one writer, because the hook and the endpoint
 * are different processes and a file is the only channel between them:
 *
 * - **hits** (`loopback-serve-hits.json`), written by the ENDPOINT on every `/w`
 *   request. Proof that a rewrite was actually followed.
 * - **latch** (`loopback-serve-reach.json`), written by the HOOK. Records the
 *   optimistic attempt and the verdict drawn from it.
 *
 * Deliberately NOT the shared `loopback-serve.json`: that file is the endpoint's
 * published coordinates and the hook only ever reads it. Two writers on one file,
 * from processes with no lock between them, is how coordinates get corrupted.
 *
 * ## Why optimistic-once, and not evidence-first
 *
 * A latch that demanded evidence before its first rewrite could never obtain any:
 * the only way to learn that a rewrite works is to rewrite. So the first serve of
 * an undecided window goes green, recording the attempt; the next serve looks for a
 * hit logged *after* that attempt and decides. A trusted session therefore stays
 * green from its very first fetch, and an untrusting one renders at most ONE TLS
 * error before every later serve takes the floor.
 *
 * ## Why the verdict expires, and why it is keyed on `startedAt`
 *
 * An `untrusted` verdict records a condition a restart fixes, so it must not
 * outlive the problem — {@link UNTRUSTED_TTL_MS}. And every verdict is tied to the
 * endpoint's `startedAt`, so a proxy restart with a regenerated CA re-probes
 * instead of inheriting a stale yes.
 *
 * The session id cannot key any of this: R9.17 records that it rotates per tool
 * call, so a per-session latch would be a fresh latch every time.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** `.golem/state/loopback-serve-hits.json` — written by the endpoint, read by the hook. */
export function loopbackHitsPath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "loopback-serve-hits.json");
}

/** `.golem/state/loopback-serve-reach.json` — the hook's own verdict. */
export function loopbackReachPath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "loopback-serve-reach.json");
}

/**
 * How long an `untrusted` verdict stands before the hook tries again.
 *
 * Ten minutes: long enough that a session which cannot use the green path stops
 * paying for the discovery on every fetch, short enough that the fix (restart
 * Claude Code so it picks up the CA) is noticed without anybody clearing state by
 * hand. The condition being recorded is fixed by a restart, so a latch that
 * outlived the problem would be its own bug.
 */
export const UNTRUSTED_TTL_MS = 10 * 60 * 1_000;

const hitsSchema = z.object({
  /** ISO timestamp of the most recent `/w` request. */
  lastHitAt: z.string(),
  /** Total `/w` requests this endpoint has served (diagnostic only). */
  count: z.number().int().nonnegative(),
});

export type LoopbackHits = z.infer<typeof hitsSchema>;

const reachSchema = z.object({
  /** The endpoint instance this verdict is about (`LoopbackServeState.startedAt`). */
  startedAt: z.string(),
  verdict: z.enum(["unknown", "trusted", "untrusted"]),
  /** When the hook last rewrote optimistically, awaiting evidence. */
  attemptedAt: z.string().optional(),
  /** When `verdict` was settled — drives the untrusted TTL. */
  decidedAt: z.string().optional(),
});

export type LoopbackReach = z.infer<typeof reachSchema>;

async function readJson<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const raw = await readFile(file, "utf8");
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = schema.safeParse(JSON.parse(stripped));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Write via a pid-suffixed temp + rename, so a concurrent reader never sees a
 * half-written file. Best-effort: a state file that cannot be written must never
 * break a hook or the endpoint (the caller degrades to "no evidence", which is the
 * safe direction — it costs one optimistic rewrite, never a wrong verdict).
 */
async function writeJson(file: string, value: unknown): Promise<boolean> {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tmp, file);
    return true;
  } catch {
    return false;
  }
}

export async function readLoopbackHits(projectDir: string): Promise<LoopbackHits | null> {
  return readJson(loopbackHitsPath(projectDir), hitsSchema);
}

export async function readLoopbackReach(projectDir: string): Promise<LoopbackReach | null> {
  return readJson(loopbackReachPath(projectDir), reachSchema);
}

export async function writeLoopbackReach(
  projectDir: string,
  reach: LoopbackReach,
): Promise<boolean> {
  return writeJson(loopbackReachPath(projectDir), reach);
}

/**
 * Record that a rewritten WebFetch actually landed on `/w`. Called by the
 * endpoint, never by the hook.
 *
 * Read-modify-write without a lock is fine here: the only field the hook compares
 * is `lastHitAt`, and two concurrent hits racing can lose a `count` increment but
 * cannot make `lastHitAt` older than it was. Under-counting a diagnostic is
 * acceptable; the trust decision does not read it.
 */
export async function recordLoopbackHit(projectDir: string, nowIso: string): Promise<void> {
  const current = await readLoopbackHits(projectDir);
  await writeJson(loopbackHitsPath(projectDir), {
    lastHitAt: nowIso,
    count: (current?.count ?? 0) + 1,
  });
}

/** What the hook should do about the green path, and what to persist afterwards. */
export interface ReachDecision {
  /** True → the green rewrite is allowed; false → take the deny floor. */
  readonly allowGreen: boolean;
  /** The latch to persist, or null when nothing changed. */
  readonly write: LoopbackReach | null;
  /** Non-secret one-liner for the hook's stderr — why this session decided this. */
  readonly reason: string;
}

/**
 * The latch, as a pure function so it can be tested without files or a clock.
 *
 * `hits` is the endpoint's record; `reach` is the previous verdict; `startedAt`
 * identifies the endpoint instance. Everything time-related arrives as `nowMs`.
 */
export function decideReach(
  startedAt: string,
  reach: LoopbackReach | null,
  hits: LoopbackHits | null,
  nowMs: number,
): ReachDecision {
  const nowIso = new Date(nowMs).toISOString();
  const fresh: LoopbackReach = { startedAt, verdict: "unknown", attemptedAt: nowIso };

  // A different endpoint instance — a restart, possibly with a regenerated CA.
  // Any previous verdict was about a different server and must not be inherited.
  if (reach === null || reach.startedAt !== startedAt) {
    return {
      allowGreen: true,
      write: fresh,
      reason: "no verdict for this endpoint yet — rewriting optimistically once",
    };
  }

  if (reach.verdict === "trusted") {
    return {
      allowGreen: true,
      write: null,
      reason: "this session has reached the endpoint before",
    };
  }

  if (reach.verdict === "untrusted") {
    const decidedMs = reach.decidedAt === undefined ? Number.NaN : Date.parse(reach.decidedAt);
    const expired = !Number.isFinite(decidedMs) || nowMs - decidedMs >= UNTRUSTED_TTL_MS;
    if (!expired) {
      return {
        allowGreen: false,
        write: null,
        reason:
          "a previous rewrite was never followed, so Claude Code's TLS does not trust our CA " +
          "here — serving the floor instead of rendering a TLS error",
      };
    }
    // The TTL is up. The condition is one a restart fixes, so try again rather
    // than latching for the life of the project.
    return {
      allowGreen: true,
      write: fresh,
      reason: "the untrusted verdict expired — trying one optimistic rewrite again",
    };
  }

  // verdict === "unknown".
  if (reach.attemptedAt === undefined) {
    return {
      allowGreen: true,
      write: fresh,
      reason: "no attempt recorded yet — rewriting optimistically once",
    };
  }

  // An attempt is outstanding: did the endpoint see a hit AFTER it? A hit from
  // before the attempt proves nothing about this session — it may well be another
  // window's, or this endpoint's previous, working client.
  const attemptedMs = Date.parse(reach.attemptedAt);
  const hitMs = hits === null ? Number.NaN : Date.parse(hits.lastHitAt);
  const followed =
    Number.isFinite(attemptedMs) && Number.isFinite(hitMs) && hitMs >= attemptedMs - 1_000;

  if (followed) {
    return {
      allowGreen: true,
      write: { startedAt, verdict: "trusted", decidedAt: nowIso },
      reason: "a rewritten fetch reached the endpoint — the green path works here",
    };
  }
  return {
    allowGreen: false,
    write: { startedAt, verdict: "untrusted", decidedAt: nowIso },
    reason:
      "the previous rewrite never reached the endpoint (cloud/Desktop sessions ignore the " +
      "settings `env` for TLS, §121-A) — serving the floor from now on",
  };
}
