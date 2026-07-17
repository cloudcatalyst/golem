/**
 * Auto-resume Phase 1 — pure usage-limit detection.
 */

import { describe, expect, it } from "vitest";
import { detectUsageLimit } from "../../../src/proxy/limit-detector.js";

const NOW = Date.parse("2026-07-17T12:00:00.000Z");

describe("detectUsageLimit", () => {
  it("returns null for a non-429 status", () => {
    expect(detectUsageLimit(200, { "retry-after": "60" }, NOW)).toBeNull();
    expect(detectUsageLimit(500, {}, NOW)).toBeNull();
  });

  it("resolves reset from retry-after seconds", () => {
    const s = detectUsageLimit(429, { "retry-after": "60" }, NOW);
    expect(s).not.toBeNull();
    expect(s?.secondsUntilReset).toBe(60);
    expect(s?.resetAtIso).toBe("2026-07-17T12:01:00.000Z");
    expect(s?.resetSource).toBe("retry-after");
    expect(s?.retryAfter).toBe("60");
  });

  it("resolves reset from an anthropic-ratelimit-*-reset RFC3339 header", () => {
    const resetIso = "2026-07-17T17:00:00.000Z"; // 5h out (session-limit-shaped)
    const s = detectUsageLimit(429, { "anthropic-ratelimit-tokens-reset": resetIso }, NOW);
    expect(s?.resetAtIso).toBe(resetIso);
    expect(s?.secondsUntilReset).toBe(5 * 3600);
    expect(s?.resetSource).toBe("anthropic-ratelimit-tokens-reset");
  });

  it("picks the FURTHEST-OUT candidate when retry-after and a reset header disagree", () => {
    const farReset = "2026-07-17T17:00:00.000Z"; // hours out
    const s = detectUsageLimit(
      429,
      { "retry-after": "30", "anthropic-ratelimit-requests-reset": farReset },
      NOW,
    );
    // The session/weekly exhaustion (hours) must win over the transient 30s bucket.
    expect(s?.resetAtIso).toBe(farReset);
    expect(s?.resetSource).toBe("anthropic-ratelimit-requests-reset");
  });

  it("returns null reset fields when a 429 carries no parseable reset", () => {
    const s = detectUsageLimit(429, { "x-request-id": "abc" }, NOW);
    expect(s).not.toBeNull();
    expect(s?.resetAtIso).toBeNull();
    expect(s?.secondsUntilReset).toBeNull();
    expect(s?.resetSource).toBeNull();
  });

  it("snapshots retry-after + anthropic-* headers only (for signal logging)", () => {
    const s = detectUsageLimit(
      429,
      {
        "retry-after": "60",
        "anthropic-ratelimit-unified-status": "exhausted", // unknown subscription-shaped header
        "content-type": "application/json", // must NOT be snapshotted
      },
      NOW,
    );
    expect(s?.headers).toStrictEqual({
      "retry-after": "60",
      "anthropic-ratelimit-unified-status": "exhausted",
    });
  });

  it("takes the first value of an array-valued header", () => {
    const s = detectUsageLimit(429, { "retry-after": ["120", "999"] }, NOW);
    expect(s?.secondsUntilReset).toBe(120);
  });

  it("clamps a past reset to 0 seconds", () => {
    const s = detectUsageLimit(429, { "retry-after": "0" }, NOW);
    expect(s?.secondsUntilReset).toBe(0);
  });
});
