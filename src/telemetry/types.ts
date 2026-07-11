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
 * One durably-recorded event: a pipeline run (redaction → compression, the
 * historical/default shape), a CCR retrieval (an `expand` call,
 * verification-notes §25), or an upstream `usage` sample (R1.1).
 *
 * `kind` is optional and absent on every event written before it existed —
 * absent MUST parse as `"request"` so old JSONL lines keep counting as
 * requests (aggregate()'s backward-compatibility contract). Only
 * {@link recordRetrieval} sets `kind: "retrieval"` and {@link recordUsageEvent}
 * sets `kind: "usage"`; `recordPipelineEvent` deliberately omits the field to
 * keep pipeline-event bytes unchanged.
 */
export interface TelemetryEvent {
  /** ISO-8601 timestamp (caller-supplied — the store never reads the clock). */
  readonly ts: string;
  readonly projectId: string;
  /** Slider level in effect for this request. Unused (0) for a retrieval. */
  readonly level: number;
  /** Discriminator; absent === "request". A retrieval/usage sample is never a request. */
  readonly kind?: "request" | "retrieval" | "usage";
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
  /** Flush and release resources. Safe to call more than once. */
  close(): Promise<void>;
}
