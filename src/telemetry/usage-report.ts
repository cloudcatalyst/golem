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

import type { UsageByLevel, UsageTotals } from "./types.js";

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
