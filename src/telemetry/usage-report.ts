/**
 * R1.1 — net-of-cache billed-cost accounting from recorded `usage` telemetry
 * (verification-notes §14/§30-37): gross forwarded/redacted/compressed token
 * counts are not a valid savings metric on a caching upstream — dropping or
 * reshaping history changes prefix bytes and can flip a 0.1x cache read into
 * a 1.0x miss on the whole suffix. The billed `usage` block is the only
 * honest number; this module turns recorded per-level totals into a
 * reportable table, pure and independent of the gross-token `CompressionStats`
 * headline.
 */

import type { UsageByBrevity, UsageByLevel, UsageBySemanticForced, UsageTotals } from "./types.js";

/**
 * Output-to-input price ratio, used ONLY to express an input-token cost and an
 * output-token saving in one unit so a net figure is possible.
 *
 * 5:1 is the current Claude ratio and has held across the tier for some time —
 * Opus 5 is $5/MTok input and $25/MTok output; Sonnet 5 is $3/$15 (checked
 * 2026-07-30, see verification-notes §87). It is a constant here rather than a
 * per-model lookup because the brevity report is a local A/B on one project's
 * own traffic, not a billing statement; if the ratio moves materially, this is
 * the one place to change.
 */
export const OUTPUT_TO_INPUT_PRICE_RATIO = 5;

/** Anthropic cache pricing multipliers relative to a full-price input token (verification-notes §14). */
export const CACHE_WRITE_MULTIPLIER = 1.25; // 5-minute-TTL cache write
export const CACHE_READ_MULTIPLIER = 0.1;

/**
 * Input-side billed cost in full-price-input-token-equivalents: uncached
 * input at 1x, cache writes at {@link CACHE_WRITE_MULTIPLIER}, cache reads at
 * {@link CACHE_READ_MULTIPLIER}. Output tokens are priced independently of
 * caching, so they are reported separately rather than folded in.
 */
export function effectiveInputTokens(usage: UsageTotals): number {
  return (
    usage.inputTokens +
    usage.cacheCreationInputTokens * CACHE_WRITE_MULTIPLIER +
    usage.cacheReadInputTokens * CACHE_READ_MULTIPLIER
  );
}

export interface LevelReportRow extends UsageTotals {
  readonly level: number;
  readonly requests: number;
  readonly effectiveInputTokens: number;
  readonly effectiveInputTokensPerRequest: number;
}

/** Turn a {@link UsageByLevel} aggregate into a reporting table, sorted by level. */
export function usageReportRows(byLevel: UsageByLevel): readonly LevelReportRow[] {
  return Object.entries(byLevel.byLevel)
    .map(([levelKey, totals]) => {
      const eff = effectiveInputTokens(totals);
      return {
        level: Number(levelKey),
        requests: totals.requests,
        inputTokens: totals.inputTokens,
        cacheCreationInputTokens: totals.cacheCreationInputTokens,
        cacheReadInputTokens: totals.cacheReadInputTokens,
        outputTokens: totals.outputTokens,
        effectiveInputTokens: eff,
        effectiveInputTokensPerRequest: totals.requests > 0 ? eff / totals.requests : 0,
      };
    })
    .sort((a, b) => a.level - b.level);
}

export interface SemanticForcedReportRow extends UsageTotals {
  readonly semanticForced: boolean;
  readonly requests: number;
  readonly effectiveInputTokens: number;
  readonly effectiveInputTokensPerRequest: number;
}

/**
 * R2.6 (verification-notes §58/§59): turn a {@link UsageBySemanticForced}
 * aggregate into a two-row gate-on/gate-off comparison table, using the same
 * honest effective-cost metric as {@link usageReportRows}. A net-safe result
 * is `forced.effectiveInputTokensPerRequest` not materially higher than
 * `notForced`'s — the bar `isCachingUpstream()`'s gate change would need to
 * clear before flipping it (spec Decisions Log entry required either way).
 */
export function semanticForcedReportRows(
  byForced: UsageBySemanticForced,
): readonly SemanticForcedReportRow[] {
  return (
    [
      ["notForced", byForced.notForced],
      ["forced", byForced.forced],
    ] as const
  ).map(([key, totals]) => {
    const eff = effectiveInputTokens(totals);
    return {
      semanticForced: key === "forced",
      requests: totals.requests,
      inputTokens: totals.inputTokens,
      cacheCreationInputTokens: totals.cacheCreationInputTokens,
      cacheReadInputTokens: totals.cacheReadInputTokens,
      outputTokens: totals.outputTokens,
      effectiveInputTokens: eff,
      effectiveInputTokensPerRequest: totals.requests > 0 ? eff / totals.requests : 0,
    };
  });
}

export interface BrevityReportRow extends UsageTotals {
  /** Brevity level these samples were recorded under ("off" is the baseline). */
  readonly brevity: string;
  readonly requests: number;
  readonly outputTokensPerRequest: number;
  /** Estimated input tokens the directive added, summed over injections. */
  readonly directiveTokens: number;
  readonly injections: number;
  /**
   * The directive's cost per request expressed in OUTPUT-token equivalents,
   * assuming the worst case that it is never cached (1x input). In practice it
   * lands inside the cached prefix at ~0.1x, so this over-states the cost —
   * deliberately, so the net figure below cannot flatter the dial.
   */
  readonly directiveCostOutputEquivPerRequest: number;
  /**
   * Output-token equivalents saved per request versus the `off` baseline, net of
   * the directive's cost. Undefined when there is no `off` baseline with
   * traffic to compare against — in which case the dial has NOT been measured
   * here, and no claim should be made either way.
   */
  readonly netOutputEquivSavedPerRequest?: number;
}

/**
 * Decision 52: turn a {@link UsageByBrevity} aggregate into a per-level table.
 *
 * This is an OBSERVATIONAL comparison across samples, never a per-request A/B —
 * the same request cannot be run both ways, so differences in what was *asked*
 * across periods are a confound the numbers cannot remove. Callers must label it
 * as an estimate. It exists because the vendor's "65% fewer output tokens" is a
 * claim about their workload, not this one, and the technique can go
 * net-negative on already-terse traffic (verification-notes §87).
 */
export function brevityReportRows(byBrevity: UsageByBrevity): readonly BrevityReportRow[] {
  const ORDER = ["off", "lite", "full", "ultra"];
  const baseline = byBrevity.byBrevity.off;
  const baselinePerRequest =
    baseline !== undefined && baseline.requests > 0
      ? baseline.outputTokens / baseline.requests
      : undefined;

  return Object.entries(byBrevity.byBrevity)
    .map(([brevity, totals]) => {
      const perRequest = totals.requests > 0 ? totals.outputTokens / totals.requests : 0;
      const costPerRequest =
        totals.requests > 0
          ? totals.directiveTokens / totals.requests / OUTPUT_TO_INPUT_PRICE_RATIO
          : 0;
      return {
        brevity,
        requests: totals.requests,
        inputTokens: totals.inputTokens,
        cacheCreationInputTokens: totals.cacheCreationInputTokens,
        cacheReadInputTokens: totals.cacheReadInputTokens,
        outputTokens: totals.outputTokens,
        outputTokensPerRequest: perRequest,
        directiveTokens: totals.directiveTokens,
        injections: totals.injections,
        directiveCostOutputEquivPerRequest: costPerRequest,
        // Only computable against a real baseline, and never for the baseline
        // itself — a row cannot be a saving versus itself.
        ...(baselinePerRequest !== undefined && brevity !== "off" && totals.requests > 0
          ? { netOutputEquivSavedPerRequest: baselinePerRequest - perRequest - costPerRequest }
          : {}),
      };
    })
    .sort((a, b) => {
      const ai = ORDER.indexOf(a.brevity);
      const bi = ORDER.indexOf(b.brevity);
      return (ai === -1 ? ORDER.length : ai) - (bi === -1 ? ORDER.length : bi);
    });
}
