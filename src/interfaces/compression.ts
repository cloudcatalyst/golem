/**
 * CompressionService — FROZEN CONTRACT (IMPLEMENTATION_PLAN §2.1).
 *
 * Implemented by `src/compression/` (WS-A task A2): the Golem-native TS lossless
 * stage for P0, with the optional Headroom Python sidecar behind the SAME
 * interface at slider >= 3 (spec Decision 18). Any Headroom client imports live
 * ONLY in `src/compression/headroom-adapter.ts`.
 *
 * Contract notes (binding on implementations):
 *
 * - At level 0 (Passthrough), `messagesOut` is the input, unchanged. At level 1
 *   (Lossless), transformations must be semantics-preserving, and SSE / tool-use
 *   structures pass through byte-faithful (CLAUDE.md hard rule).
 * - Determinism for prompt-cache stability (verification-notes.md §14):
 *   re-compressing a previously-sent message prefix MUST reproduce byte-identical
 *   output — Anthropic cache hits require an exact prefix match, so
 *   implementations store/replay prior turns' compressed forms rather than
 *   re-deriving them non-deterministically.
 * - Redaction is NOT this service's job; it runs strictly before compress()
 *   in the pipeline and must never be weakened or reordered after it.
 * - CPU-heavy work must not block the proxy's event loop (worker_threads).
 */

import type { PipelinePolicy } from "./policy.js";

/**
 * An Anthropic Messages-API message object (`{"role": ..., "content": ...}`).
 * Kept as an untyped record, not a model class, so the proxy stays byte-faithful.
 */
export type Message = Readonly<Record<string, unknown>>;

/** Reference to an original stored in the Compress-Cache-Retrieve store. */
export interface CCRRef {
  readonly refId: string;
  readonly contentType: string;
  readonly originalTokens: number;
}

/** Token count before/after one stage. */
export interface TokenDelta {
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

export function tokensSaved(delta: TokenDelta): number {
  return delta.tokensBefore - delta.tokensAfter;
}

/** Output of one compress() call. */
export interface CompressResult {
  readonly messagesOut: readonly Message[];
  readonly refs: readonly CCRRef[];
  readonly stageSavings: Readonly<Record<string, TokenDelta>>;
}

/** A retrieved original for a CCR reference. */
export interface Original {
  readonly ref: CCRRef;
  readonly content: string;
}

/** Cumulative savings, optionally scoped to a project. */
export interface CompressionStats {
  readonly projectId: string | null;
  readonly requests: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly perStage: Readonly<Record<string, TokenDelta>>;
  readonly ccrRefsStored: number;
  readonly ccrRefsRetrieved: number;
}

/** Thrown by retrieve() when a CCR ref does not exist (or was evicted). */
export class UnknownRefError extends Error {
  constructor(refId: string) {
    super(`unknown CCR ref: ${refId}`);
    this.name = "UnknownRefError";
  }
}

/** The compression stage of the proxy pipeline. */
export interface CompressionService {
  compress(
    messages: readonly Message[],
    policy: PipelinePolicy,
    projectId: string,
  ): Promise<CompressResult>;

  /** Return the original for `ref`; reject with UnknownRefError if absent. */
  retrieve(ref: CCRRef): Promise<Original>;

  stats(projectId?: string): Promise<CompressionStats>;
}
