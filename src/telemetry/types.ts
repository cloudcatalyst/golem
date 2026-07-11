/**
 * WS-A A4 — telemetry types.
 *
 * A `TelemetryStore` durably records one event per pipeline run (redaction →
 * compression) and answers aggregate savings queries in the frozen
 * `CompressionStats` shape, so E3's `golem stats` / dashboard can read durable,
 * cross-session numbers instead of the in-memory per-process counters.
 *
 * The store is behind an interface so the backend can swap: the P0 default is a
 * dependency-free append-only JSONL log (chosen over `node:sqlite`, which is
 * still flagged experimental on Node 22–24 and emits a runtime warning — see
 * verification-notes §25). Writes are append-only and off the request critical
 * path (fire-and-forget with a flush on close).
 */

import type { CompressionStats, TokenDelta } from "../interfaces/compression.js";

/**
 * Billed-cost inputs from one upstream response's `usage` block (R1.1,
 * verification-notes §30-37): `input_tokens`, `cache_creation_input_tokens`,
 * `cache_read_input_tokens`, `output_tokens`, camelCased. This is the ONLY
 * honest net-of-cache signal — gross forwarded/redacted/compressed token
 * counts say nothing about billed cost on a caching upstream.
 */
export interface UsageTotals {
  readonly inputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly outputTokens: number;
}

/** Per-level usage rollup, scoped like {@link CompressionStats}. */
export interface UsageByLevel {
  readonly projectId: string | null;
  readonly byLevel: Readonly<Record<number, UsageTotals & { readonly requests: number }>>;
}

/**
 * R2.6 (verification-notes §58/§59) A/B rollup: usage samples split by
 * whether `compression.force_semantic_on_caching` was on for that sample,
 * independent of level (the gate is a static per-run setting, not a
 * per-request decision — see {@link recordUsageEvent}).
 */
export interface UsageBySemanticForced {
  readonly projectId: string | null;
  readonly forced: UsageTotals & { readonly requests: number };
  readonly notForced: UsageTotals & { readonly requests: number };
}

/**
 * One durably-recorded event: a pipeline run (redaction → compression, the
 * historical/default shape), a CCR retrieval (an `expand` call,
 * verification-notes §25), an upstream `usage` sample (R1.1), or an
 * `avoidedUpstream` sample (R2.2 — context-substitution input tokens elided
 * because they were already recognized from the project's web-cache).
 *
 * `kind` is optional and absent on every event written before it existed —
 * absent MUST parse as `"request"` so old JSONL lines keep counting as
 * requests (aggregate()'s backward-compatibility contract). Only
 * {@link recordRetrieval} sets `kind: "retrieval"`, {@link recordUsageEvent}
 * sets `kind: "usage"`, and {@link recordAvoidedUpstream} sets
 * `kind: "avoidedUpstream"`; `recordPipelineEvent` deliberately omits the
 * field to keep pipeline-event bytes unchanged.
 */
export interface TelemetryEvent {
  /** ISO-8601 timestamp (caller-supplied — the store never reads the clock). */
  readonly ts: string;
  readonly projectId: string;
  /** Slider level in effect for this request. Unused (0) for a retrieval. */
  readonly level: number;
  /** Discriminator; absent === "request". A retrieval/usage/avoidedUpstream sample is never a request. */
  readonly kind?: "request" | "retrieval" | "usage" | "avoidedUpstream";
  /**
   * Whole-request before/after — the honest headline savings. Optional for
   * backward compatibility with events written before this field existed;
   * aggregate() falls back to the (mixed-scope) stage stitch when absent.
   * Absent on retrieval/usage events (they carry no gross token savings).
   */
  readonly requestTokens?: TokenDelta;
  /** Per-stage token deltas (breakdown only; mixed scopes — do not sum). */
  readonly stageSavings: Readonly<Record<string, TokenDelta>>;
  /** CCR originals stored by this request. 0 for a retrieval/usage event. */
  readonly ccrRefsStored: number;
  /**
   * CCR originals retrieved. Only set (kind: "retrieval") by
   * {@link recordRetrieval}; absent/0 on pipeline events, which never retrieve.
   */
  readonly ccrRefsRetrieved?: number;
  /**
   * The upstream response's billed-cost `usage` block. Only set
   * (kind: "usage") by {@link recordUsageEvent}; absent on pipeline/retrieval
   * events.
   */
  readonly usage?: UsageTotals;
  /**
   * R2.6: whether `compression.force_semantic_on_caching` was on when this
   * usage sample was recorded (a static per-run setting, not a per-request
   * pipeline decision — see {@link recordUsageEvent}). Only set on `kind:
   * "usage"` events; absent/false elsewhere and on events written before
   * this field existed.
   */
  readonly semanticForced?: boolean;
  /**
   * R2.2 (spec Decision 24 sub-mode 1, verification-notes §62): input tokens
   * avoided by proxy-side context substitution for this sample. Only set
   * (kind: "avoidedUpstream") by {@link recordAvoidedUpstream}; absent
   * elsewhere.
   */
  readonly avoidedUpstreamInputTokens?: number;
  /**
   * R2.3 (spec Decision 24 sub-mode 2 / Decision 33): output tokens avoided
   * by the local-answer sub-mode short-circuiting the upstream call entirely
   * — the analogous output-token field the R2.2 doc comment anticipated,
   * added to the SAME `avoidedUpstream` event kind rather than a new one.
   * Only set (kind: "avoidedUpstream") by {@link recordAvoidedUpstream};
   * absent elsewhere and on events written before this field existed.
   */
  readonly avoidedUpstreamOutputTokens?: number;
}

/** R2.2/R2.3 rollup: total input/output tokens avoided via either sub-mode. */
export interface AvoidedUpstreamStats {
  readonly projectId: string | null;
  readonly events: number;
  readonly inputTokensAvoided: number;
  /** R2.3: output tokens avoided by the local-answer sub-mode. 0 if unused. */
  readonly outputTokensAvoided: number;
}

export interface TelemetryStore {
  /** Durably record one event. Resolves once persisted. */
  record(event: TelemetryEvent): Promise<void>;
  /**
   * Aggregate recorded events into CompressionStats. `projectId` scopes to one
   * project; omit for the global (projectId: null) view.
   */
  aggregate(projectId?: string): Promise<CompressionStats>;
  /**
   * Roll up recorded `usage` (kind: "usage") events by slider level (R1.1) —
   * the net-of-cache A/B input. `projectId` scopes to one project; omit for
   * the global view. Independent of {@link aggregate}: usage events never
   * count toward `CompressionStats` (that stays the gross-token headline).
   */
  aggregateUsageByLevel(projectId?: string): Promise<UsageByLevel>;
  /**
   * Roll up recorded `usage` events by the R2.6 `semanticForced` tag
   * (verification-notes §58/§59) — the gate-on vs gate-off-for-this-tier A/B
   * `isCachingUpstream()`'s bypass needs to be judged on. `projectId` scopes
   * to one project; omit for the global view.
   */
  aggregateUsageBySemanticForced(projectId?: string): Promise<UsageBySemanticForced>;
  /**
   * Roll up recorded `avoidedUpstream` (kind: "avoidedUpstream") events (R2.2,
   * verification-notes §59/§62) — the direct KB-substitution signal R2.1
   * found no telemetry existed for. `projectId` scopes to one project; omit
   * for the global view. Independent of {@link aggregate}: these events never
   * count toward `CompressionStats` (same treatment as `usage` events).
   */
  aggregateAvoidedUpstream(projectId?: string): Promise<AvoidedUpstreamStats>;
  /** Flush and release resources. Safe to call more than once. */
  close(): Promise<void>;
}
