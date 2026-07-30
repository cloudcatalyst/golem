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
 * Decision 52 rollup: BILLED usage split by the brevity level in force, plus
 * the input cost the directive added. This is the measurement the dial ships
 * gated behind — Caveman's own README warns the technique can go net-negative
 * on terse workloads (verification-notes §87), so the honest report is
 * per-level observed output tokens *and* the cost of asking for them.
 *
 * It is an OBSERVATIONAL comparison across samples, not a per-request A/B: the
 * same request cannot be run both ways. Consumers must label it as such.
 */
export interface UsageByBrevity {
  readonly projectId: string | null;
  /**
   * Keyed by brevity level ("off" | "lite" | "full" | "ultra"). Absent keys mean
   * no samples were seen at that level.
   */
  readonly byBrevity: Readonly<
    Record<
      string,
      UsageTotals & {
        readonly requests: number;
        /**
         * Estimated input tokens the directive added across these requests.
         * Accumulated from pipeline events, which is a DIFFERENT event kind from
         * the usage samples above — so `requests` here counts usage samples and
         * this counts injections; they are not guaranteed equal (a request can
         * be recorded without its response, or vice versa).
         */
        readonly directiveTokens: number;
        /** How many pipeline events contributed `directiveTokens`. */
        readonly injections: number;
      }
    >
  >;
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
  /** Discriminator; absent === "request". A retrieval/usage/avoidedUpstream/tool sample is never a request. */
  readonly kind?: "request" | "retrieval" | "usage" | "avoidedUpstream" | "tool";
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
   * Decision 52: the brevity level in force for this sample. Set on `kind:
   * "usage"` events (where the billed output-token count lives) and on pipeline
   * events (where the directive's input cost lives). Absent on events written
   * before this field existed — parse absent as `"off"`, since brevity did not
   * exist then and so cannot have been on.
   */
  readonly brevity?: string;
  /**
   * Decision 52: input tokens the brevity directive ADDED to this request. Set
   * on pipeline events only. Recorded so a brevity saving can never be reported
   * without its cost (verification-notes §87).
   */
  readonly brevityDirectiveTokens?: number;
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
  /**
   * R4.3 (verification-notes §59 gap): the local knowledge/coder MCP tool this
   * event measures (`search`/`fetch`/`ingest`/`wiki_read`/`coder`). Only set
   * (kind: "tool") by {@link recordToolCall}; absent elsewhere.
   */
  readonly tool?: string;
  /** R4.3: wall-clock duration of the tool call in milliseconds. kind: "tool" only. */
  readonly toolDurationMs?: number;
  /** R4.3: serialized size of the tool's structured result in bytes. kind: "tool" only. */
  readonly toolResultBytes?: number;
  /** R4.3: for `coder`, the local model that produced the draft. kind: "tool" only. */
  readonly toolModel?: string;
  /**
   * R8.1: cacheable-prefix verdict for this request — `"first"`, `"append"`, or
   * `"bust"`. Set on pipeline events only; absent on other kinds and on events
   * written before this field existed (parse absent as "unknown", NOT as a hit —
   * an unobserved request is not evidence of anything).
   */
  readonly cachePrefix?: string;
  /**
   * R8.1: which cacheable component broke the prefix (`tools` | `system` |
   * `messages`). Set only alongside `cachePrefix: "bust"`.
   */
  readonly cacheBustComponent?: string;
  /**
   * R8.13: 0-based index of the first message whose bytes differed, when
   * `cacheBustComponent === "messages"`. The discriminator §99 was missing: a
   * change at index 2 of 180 invalidates the whole history, while a change at
   * index 179 of 180 costs the tail only. Without it every bust reads equally
   * catastrophic and the verdict cannot be reconciled with the billed split.
   */
  readonly cacheBustMessageIndex?: number;
  /**
   * R8.13: how many messages the classified request carried. Only meaningful
   * beside {@link cacheBustMessageIndex} — the index is a position, and a
   * position without a length says nothing about how much prefix was lost.
   */
  readonly cacheMessageCount?: number;
  /**
   * R4.3: for `coder`, the character length of the locally-drafted text — the
   * "drafted-locally" bucket (output the paid model did not have to generate).
   * kind: "tool" only.
   */
  readonly toolDraftChars?: number;
}

/** R4.3 rollup: per-tool call counts, latency, result size, and drafted-locally bytes. */
export interface ToolUsagePerTool {
  readonly calls: number;
  readonly totalDurationMs: number;
  readonly totalResultBytes: number;
  /** Sum of `coder` draft characters (0 for non-drafting tools). */
  readonly draftChars: number;
}

export interface ToolUsageStats {
  readonly projectId: string | null;
  readonly byTool: Readonly<Record<string, ToolUsagePerTool>>;
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
   * Decision 52: roll up `usage` events by the brevity level in force, plus the
   * directive's own input cost from pipeline events. The gate on trusting the
   * brevity dial — it ships off until this reports a real net saving on the
   * project's own traffic. `projectId` scopes to one project; omit for global.
   */
  aggregateUsageByBrevity(projectId?: string): Promise<UsageByBrevity>;
  /**
   * Roll up recorded `avoidedUpstream` (kind: "avoidedUpstream") events (R2.2,
   * verification-notes §59/§62) — the direct KB-substitution signal R2.1
   * found no telemetry existed for. `projectId` scopes to one project; omit
   * for the global view. Independent of {@link aggregate}: these events never
   * count toward `CompressionStats` (same treatment as `usage` events).
   */
  aggregateAvoidedUpstream(projectId?: string): Promise<AvoidedUpstreamStats>;
  /**
   * Roll up recorded `tool` (kind: "tool") events (R4.3) — per-tool call
   * counts, total latency, result bytes, and drafted-locally chars. Closes the
   * verification-notes §59 gap: the local knowledge/coder tools were entirely
   * uninstrumented. `projectId` scopes to one project; omit for the global
   * view. Independent of {@link aggregate}: tool events never count toward
   * `CompressionStats` (same treatment as usage/avoidedUpstream events).
   */
  aggregateToolUsage(projectId?: string): Promise<ToolUsageStats>;
  /** Flush and release resources. Safe to call more than once. */
  close(): Promise<void>;
}
