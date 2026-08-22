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

/**
 * What a store checked before giving up on a ref — carried on
 * {@link UnknownRefError} so a caller can tell "never stored" apart from
 * "stored under a different root" apart from "corrupt" (task ccr-ref-scope:
 * one error name used to cover all three, plus a hypothetical eviction that
 * no implementation of this contract actually has).
 */
export interface UnknownRefOptions {
  /**
   * Where the store looked: a filesystem path, an S3 key prefix, or a plain
   * description for a backend with no single location (e.g. "in-memory").
   * Shown in the message so "no envelope at <path>" is actionable rather than
   * a bare "unknown or expired".
   */
  readonly location?: string;
  /**
   * "not-found" (default): nothing was stored at `location` under this
   * refId — never stored at all, or stored under a DIFFERENT root than the
   * one this store is rooted at (the ccr-ref-scope worktree bug). "corrupt":
   * an envelope exists at `location` but failed to parse or validate — see
   * `detail`.
   */
  readonly reason?: "not-found" | "corrupt";
  /** Why a "corrupt" envelope failed (JSON parse error, schema issues). */
  readonly detail?: string;
}

/**
 * Thrown by retrieve() when a CCR ref cannot be resolved. Distinguishes its
 * causes (see {@link UnknownRefOptions}) rather than reporting one
 * "unknown or expired" for all of them — no implementation of this contract
 * has ever implemented eviction, so "expired" was never a real cause.
 */
export class UnknownRefError extends Error {
  readonly refId: string;
  readonly location: string;
  readonly reason: "not-found" | "corrupt";

  constructor(refId: string, options: UnknownRefOptions = {}) {
    const location = options.location ?? "an unspecified CCR store";
    const reason = options.reason ?? "not-found";
    const message =
      reason === "corrupt"
        ? `CCR ref "${refId}" has a stored envelope at ${location} that is ` +
          `corrupt (${options.detail ?? "no further detail"}) — it exists but cannot be read back.`
        : `no envelope for CCR ref "${refId}" at ${location} — either it was ` +
          "never stored, or it was stored under a different project root.";
    super(message);
    this.name = "UnknownRefError";
    this.refId = refId;
    this.location = location;
    this.reason = reason;
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
