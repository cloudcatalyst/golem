/**
 * SemanticCompressor — the neutral seam for slider ≥3 semantic compression.
 *
 * The pipeline depends on THIS abstraction, never on Headroom directly, so the
 * CLAUDE.md rule "any Headroom client imports live only in headroom-adapter.ts"
 * holds: `headroom-adapter.ts` provides the implementation; the pipeline and
 * tests know only this interface.
 *
 * Contrast with the frozen `CompressionService` (lossless, byte-stable, levels
 * ≤2): a SemanticCompressor is LOSSY and NOT guaranteed prefix-stable — it may
 * change earlier-turn bytes and so can miss Anthropic's prompt cache. That is an
 * accepted trade-off gated to slider ≥3 (spec §4; verification-notes §34), and it
 * must always be optional and fail-open (a null result → the pipeline skips it
 * and forwards the losslessly-compressed body unchanged).
 */

import type { SemanticCompression } from "../interfaces/policy.js";

/** The slider's non-"off" semantic-compression modes (level ≥3). */
export type SemanticMode = Exclude<SemanticCompression, "off">;

export interface SemanticResult {
  /** Compressed messages, same shape as the input. */
  readonly messages: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  /** Backend-reported transform tags (e.g. `read_lifecycle:…`, `router:…`). */
  readonly transformsApplied: readonly string[];
}

export interface SemanticCompressor {
  /**
   * Compress `messages` at the given mode. MUST fail open: resolve `null` (not
   * reject) when the backend is unavailable/misbehaving, so the pipeline can skip
   * the stage and keep the byte-faithful lossless body.
   */
  compress(
    messages: ReadonlyArray<Readonly<Record<string, unknown>>>,
    mode: SemanticMode,
  ): Promise<SemanticResult | null>;
}
