/**
 * R2.6 (verification-notes §58/§59) — semanticForcedReportRows, the
 * gate-on/gate-off effective-cost comparison table used to judge whether
 * bypassing isCachingUpstream() for the semantic stage is net-safe.
 */

import { describe, expect, it } from "vitest";
import type { UsageBySemanticForced } from "../../../src/telemetry/types.js";
import { semanticForcedReportRows } from "../../../src/telemetry/usage-report.js";

describe("semanticForcedReportRows", () => {
  it("produces a notForced/forced pair with the same effective-cost formula as usageReportRows", () => {
    const byForced: UsageBySemanticForced = {
      projectId: "projA",
      forced: {
        requests: 2,
        inputTokens: 100,
        cacheCreationInputTokens: 40,
        cacheReadInputTokens: 2000,
        outputTokens: 50,
      },
      notForced: {
        requests: 4,
        inputTokens: 200,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 8000,
        outputTokens: 90,
      },
    };

    const rows = semanticForcedReportRows(byForced);
    expect(rows).toHaveLength(2);

    const notForced = rows.find((r) => !r.semanticForced);
    const forced = rows.find((r) => r.semanticForced);
    expect(notForced).toBeDefined();
    expect(forced).toBeDefined();

    // effectiveInputTokens = input*1 + cacheCreation*1.25 + cacheRead*0.1
    expect(forced?.effectiveInputTokens).toBeCloseTo(100 + 40 * 1.25 + 2000 * 0.1, 6);
    expect(forced?.effectiveInputTokensPerRequest).toBeCloseTo(forced!.effectiveInputTokens / 2, 6);
    expect(notForced?.effectiveInputTokens).toBeCloseTo(200 + 0 * 1.25 + 8000 * 0.1, 6);
    expect(notForced?.effectiveInputTokensPerRequest).toBeCloseTo(
      notForced!.effectiveInputTokens / 4,
      6,
    );
  });

  it("reports 0 per-request cost (not NaN) when a bucket has no requests", () => {
    const byForced: UsageBySemanticForced = {
      projectId: null,
      forced: {
        requests: 0,
        inputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      },
      notForced: {
        requests: 1,
        inputTokens: 10,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 1,
      },
    };
    const rows = semanticForcedReportRows(byForced);
    const forced = rows.find((r) => r.semanticForced);
    expect(forced?.effectiveInputTokensPerRequest).toBe(0);
  });
});
