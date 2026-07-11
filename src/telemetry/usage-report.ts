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

import type { UsageByLevel, UsageBySemanticForced, UsageTotals } from "./types.js";

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
