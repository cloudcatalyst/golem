/**
 * R9.19 — the reachability latch R9.12 designed and did not build.
 *
 * R9.12 shipped two of three trust signals: a published endpoint, and
 * `NODE_EXTRA_CA_CERTS` in the hook's own environment naming our CA, confirmed by a
 * TLS probe from the hook. §125 then measured that a hook's environment reflects
 * the settings FILE, not necessarily what Claude Code's TLS stack honours, and
 * §121-A records that the two disagree in cloud and Desktop-app-managed sessions.
 *
 * So all of R9.12's checks can pass in a session where the rewrite fails with an
 * opaque TLS error. Nothing is lost (§122: `additionalContext` still delivers the
 * page) but the transcript shows a failure where the floor would have shown
 * Golem's own `NOT AN ERROR —` framing — strictly worse in appearance than R9.7,
 * the one thing R9.12 promised not to be.
 *
 * `decideReach` is the third signal, kept pure so the whole state machine is
 * testable without files, a clock, or a real TLS stack.
 */

import { describe, expect, it } from "vitest";
import {
  decideReach,
  type LoopbackHits,
  type LoopbackReach,
  UNTRUSTED_TTL_MS,
} from "../../../src/proxy/loopback-reach.js";

const STARTED = "2026-08-14T10:00:00.000Z";
const T0 = Date.parse("2026-08-14T10:05:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

const hitsAt = (ms: number): LoopbackHits => ({ lastHitAt: iso(ms), count: 1 });

describe("decideReach (R9.19)", () => {
  /**
   * The requirement that rules out the obvious design. A latch demanding evidence
   * before its first rewrite could never obtain any — the only way to learn that a
   * rewrite works is to rewrite. So a trusted session must be green from fetch one.
   */
  it("rewrites optimistically when there is no verdict yet", () => {
    const d = decideReach(STARTED, null, null, T0);
    expect(d.allowGreen).toBe(true);
    expect(d.write).toEqual({ startedAt: STARTED, verdict: "unknown", attemptedAt: iso(T0) });
    expect(d.reason).toContain("optimistically");
  });

  it("goes green and latches TRUSTED once a rewrite has been followed", () => {
    const reach: LoopbackReach = {
      startedAt: STARTED,
      verdict: "unknown",
      attemptedAt: iso(T0),
    };
    // The endpoint recorded a `/w` request after the attempt — proof the rewrite
    // was followed by Claude Code's own TLS stack, not just reachable from here.
    const d = decideReach(STARTED, reach, hitsAt(T0 + 500), T0 + 1_000);
    expect(d.allowGreen).toBe(true);
    expect(d.write).toEqual({ startedAt: STARTED, verdict: "trusted", decidedAt: iso(T0 + 1_000) });
  });

  /** The gate: at most ONE TLS error, then the floor. */
  it("latches UNTRUSTED when the previous rewrite was never followed", () => {
    const reach: LoopbackReach = { startedAt: STARTED, verdict: "unknown", attemptedAt: iso(T0) };
    const d = decideReach(STARTED, reach, null, T0 + 1_000);
    expect(d.allowGreen).toBe(false);
    expect(d.write?.verdict).toBe("untrusted");
    expect(d.reason).toContain("121-A");
  });

  it("keeps serving the floor while an untrusted verdict stands", () => {
    const reach: LoopbackReach = {
      startedAt: STARTED,
      verdict: "untrusted",
      decidedAt: iso(T0),
    };
    for (const offset of [1, 1_000, UNTRUSTED_TTL_MS - 1]) {
      const d = decideReach(STARTED, reach, null, T0 + offset);
      expect(d.allowGreen, `should still be floored at +${offset}ms`).toBe(false);
      expect(d.write).toBeNull(); // nothing to rewrite — the verdict already stands
    }
  });

  /**
   * The verdict records a condition a restart fixes, so it must not outlive the
   * problem. A latch that never expired would keep a session on the floor for the
   * life of the project after one bad window.
   */
  it("retries once when the untrusted verdict expires", () => {
    const reach: LoopbackReach = { startedAt: STARTED, verdict: "untrusted", decidedAt: iso(T0) };
    const d = decideReach(STARTED, reach, null, T0 + UNTRUSTED_TTL_MS);
    expect(d.allowGreen).toBe(true);
    expect(d.write).toEqual({
      startedAt: STARTED,
      verdict: "unknown",
      attemptedAt: expect.any(String),
    });
    expect(d.reason).toContain("expired");
  });

  it("treats an untrusted verdict with no timestamp as expired rather than permanent", () => {
    // A truncated or hand-edited state file must fail towards trying again, not
    // towards a floor nobody can clear.
    const d = decideReach(STARTED, { startedAt: STARTED, verdict: "untrusted" }, null, T0);
    expect(d.allowGreen).toBe(true);
  });

  /**
   * A restart may regenerate the CA, so a verdict about the previous endpoint says
   * nothing about this one. Keyed on `startedAt` because the session id cannot be
   * used: R9.17 records that it rotates per tool call.
   */
  it("discards a verdict from a previous endpoint instance", () => {
    const stale: LoopbackReach = {
      startedAt: "2026-08-14T09:00:00.000Z",
      verdict: "untrusted",
      decidedAt: iso(T0),
    };
    const d = decideReach(STARTED, stale, null, T0);
    expect(d.allowGreen).toBe(true);
    expect(d.write?.startedAt).toBe(STARTED);
    expect(d.write?.verdict).toBe("unknown");
  });

  it("does not accept a hit from BEFORE the attempt as evidence", () => {
    // Another window's hit, or this endpoint's previous working client, proves
    // nothing about the rewrite this session just made.
    const reach: LoopbackReach = { startedAt: STARTED, verdict: "unknown", attemptedAt: iso(T0) };
    const d = decideReach(STARTED, reach, hitsAt(T0 - 60_000), T0 + 1_000);
    expect(d.allowGreen).toBe(false);
    expect(d.write?.verdict).toBe("untrusted");
  });

  it("stays green on every later fetch once trusted, without rewriting state", () => {
    const reach: LoopbackReach = { startedAt: STARTED, verdict: "trusted", decidedAt: iso(T0) };
    const d = decideReach(STARTED, reach, hitsAt(T0), T0 + 86_400_000);
    expect(d.allowGreen).toBe(true);
    expect(d.write).toBeNull();
  });

  /**
   * The exact sequence the gate describes, run as a sequence: an untrusting
   * session renders AT MOST ONE failed fetch.
   */
  it("an untrusting session goes green exactly once, then floors", () => {
    let reach: LoopbackReach | null = null;
    const verdicts: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      // No hits are ever recorded — Claude Code's TLS rejects our cert, so the
      // rewritten fetch never lands on `/w`.
      const d = decideReach(STARTED, reach, null, T0 + i * 1_000);
      verdicts.push(d.allowGreen);
      if (d.write !== null) reach = d.write;
    }
    expect(verdicts).toEqual([true, false, false, false, false]);
  });

  it("a trusted session is green on every fetch including the first", () => {
    let reach: LoopbackReach | null = null;
    let lastHit = Number.NaN;
    const verdicts: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const now = T0 + i * 1_000;
      const d = decideReach(STARTED, reach, Number.isFinite(lastHit) ? hitsAt(lastHit) : null, now);
      verdicts.push(d.allowGreen);
      if (d.write !== null) reach = d.write;
      // A green rewrite is followed, so the endpoint records a hit.
      if (d.allowGreen) lastHit = now + 100;
    }
    expect(verdicts).toEqual([true, true, true, true, true]);
  });
});
