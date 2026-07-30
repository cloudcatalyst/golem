/**
 * R8.1 — the cache rollup.
 *
 * The properties that matter are honesty properties: "no data" must not render as
 * "0% hit rate", the billed and predicted signals must stay separate, and an
 * unobserved request must never be counted as a hit.
 */

import { describe, expect, it } from "vitest";
import { aggregateCacheStats, renderCacheReport } from "../../../src/telemetry/cache-report.js";
import type { TelemetryEvent } from "../../../src/telemetry/types.js";

function usageEvent(
  over: { cacheRead?: number; cacheCreation?: number; input?: number; projectId?: string } = {},
): TelemetryEvent {
  return {
    ts: "2026-07-30T00:00:00.000Z",
    projectId: over.projectId ?? "p1",
    level: 3,
    kind: "usage",
    stageSavings: {},
    ccrRefsStored: 0,
    usage: {
      inputTokens: over.input ?? 0,
      cacheCreationInputTokens: over.cacheCreation ?? 0,
      cacheReadInputTokens: over.cacheRead ?? 0,
      outputTokens: 100,
    },
  };
}

function requestEvent(
  cachePrefix?: string,
  cacheBustComponent?: string,
  projectId = "p1",
): TelemetryEvent {
  return {
    ts: "2026-07-30T00:00:00.000Z",
    projectId,
    level: 3,
    stageSavings: {},
    ccrRefsStored: 0,
    ...(cachePrefix !== undefined ? { cachePrefix } : {}),
    ...(cacheBustComponent !== undefined ? { cacheBustComponent } : {}),
  };
}

describe("aggregateCacheStats", () => {
  it("returns a null hit rate for no events, not zero", () => {
    const stats = aggregateCacheStats([]);
    expect(stats.samples).toBe(0);
    expect(stats.hitRate).toBeNull();
  });

  it("returns a null hit rate when samples exist but bill nothing", () => {
    expect(aggregateCacheStats([usageEvent()]).hitRate).toBeNull();
  });

  it("sums billed cache tokens and computes the hit rate over all input", () => {
    const stats = aggregateCacheStats([
      usageEvent({ cacheRead: 900, cacheCreation: 0, input: 100 }),
      usageEvent({ cacheRead: 900, cacheCreation: 100, input: 0 }),
    ]);
    expect(stats.samples).toBe(2);
    expect(stats.cacheReadTokens).toBe(1800);
    expect(stats.cacheCreationTokens).toBe(100);
    expect(stats.uncachedInputTokens).toBe(100);
    expect(stats.hitRate).toBeCloseTo(1800 / 2000, 6);
  });

  it("counts prefix verdicts from request events", () => {
    const stats = aggregateCacheStats([
      requestEvent("first"),
      requestEvent("append"),
      requestEvent("append"),
      requestEvent("bust", "tools"),
    ]);
    expect(stats.prefix).toEqual({ first: 1, append: 2, bust: 1, unobserved: 0 });
    expect(stats.busts.tools).toBe(1);
  });

  it("counts a request with NO verdict as unobserved, never as a hit", () => {
    const stats = aggregateCacheStats([requestEvent(), requestEvent("append")]);
    expect(stats.prefix.unobserved).toBe(1);
    expect(stats.prefix.append).toBe(1);
  });

  it("attributes busts per component and flags unattributed ones", () => {
    const stats = aggregateCacheStats([
      requestEvent("bust", "tools"),
      requestEvent("bust", "system"),
      requestEvent("bust", "messages"),
      requestEvent("bust", "messages"),
      requestEvent("bust"),
    ]);
    expect(stats.prefix.bust).toBe(5);
    expect(stats.busts).toEqual({ tools: 1, system: 1, messages: 2, unattributed: 1 });
  });

  it("keeps the billed and predicted signals independent", () => {
    // Usage events carry no verdict and request events carry no billing; neither
    // may leak into the other's counters.
    const stats = aggregateCacheStats([
      usageEvent({ cacheRead: 500, input: 500 }),
      requestEvent("bust", "system"),
    ]);
    expect(stats.samples).toBe(1);
    expect(stats.prefix.bust).toBe(1);
    expect(stats.prefix.unobserved).toBe(0);
  });

  it("ignores non-request, non-usage event kinds", () => {
    const retrieval: TelemetryEvent = {
      ts: "2026-07-30T00:00:00.000Z",
      projectId: "p1",
      level: 0,
      kind: "retrieval",
      stageSavings: {},
      ccrRefsStored: 0,
      ccrRefsRetrieved: 1,
    };
    const stats = aggregateCacheStats([retrieval, requestEvent("append")]);
    expect(stats.prefix).toEqual({ first: 0, append: 1, bust: 0, unobserved: 0 });
    expect(stats.samples).toBe(0);
  });

  it("scopes to a project id when given", () => {
    const stats = aggregateCacheStats(
      [
        usageEvent({ cacheRead: 100, projectId: "mine" }),
        usageEvent({ cacheRead: 999, projectId: "other" }),
        requestEvent("bust", "tools", "other"),
      ],
      "mine",
    );
    expect(stats.cacheReadTokens).toBe(100);
    expect(stats.prefix.bust).toBe(0);
  });
});

describe("renderCacheReport", () => {
  it("says there is no data rather than printing a 0% hit rate", () => {
    const out = renderCacheReport(aggregateCacheStats([]));
    expect(out).toContain("no usage samples yet");
    expect(out).not.toContain("hit rate 0.0%");
  });

  it("reports the hit rate and the rate multipliers", () => {
    const out = renderCacheReport(
      aggregateCacheStats([usageEvent({ cacheRead: 900, cacheCreation: 100 })]),
    );
    expect(out).toContain("hit rate 90.0%");
    expect(out).toContain("~0.1x rate");
  });

  it("names the bust breakdown and calls out a tools bust as the expensive one", () => {
    const out = renderCacheReport(
      aggregateCacheStats([requestEvent("bust", "tools"), requestEvent("append")]),
    );
    expect(out).toContain("BUST (re-prefilled)");
    expect(out).toContain("tools 1");
    expect(out).toContain("re-prefills the WHOLE prefix");
  });

  it("discloses unobserved coverage so a low bust count is not misread", () => {
    const out = renderCacheReport(aggregateCacheStats([requestEvent(), requestEvent()]));
    expect(out).toContain("carried no verdict");
  });

  it("always states that the verdicts are a prediction", () => {
    const out = renderCacheReport(aggregateCacheStats([requestEvent("append")]));
    expect(out).toContain("Billed numbers are authoritative");
    expect(out).toContain("heuristic");
  });
});
