/**
 * WS-A A4 — telemetry: durable per-stage savings attribution.
 *
 * The pipeline (A3) emits a PipelineEvent per request; `recordPipelineEvent`
 * adapts it to a TelemetryEvent and persists it via a TelemetryStore (P0
 * backend: append-only JSONL). E3's `golem stats` / dashboard read durable
 * aggregates through `telemetryStatsSource`, which conforms to E3's StatsSource
 * seam (`{ kind, note, stats(projectId?) }`) — no import from src/cli needed.
 */

import type { CompressionStats } from "../interfaces/compression.js";
import type { PipelineEvent } from "../pipeline/index.js";
import type { ResponseUsage } from "../proxy/types.js";
import { JsonlTelemetryStore } from "./jsonl-store.js";
import type { TelemetryEvent, TelemetryStore, UsageTotals } from "./types.js";

export { JsonlTelemetryStore, telemetryFilePath } from "./jsonl-store.js";
export type {
  AvoidedUpstreamStats,
  TelemetryEvent,
  TelemetryStore,
  UsageByLevel,
  UsageBySemanticForced,
  UsageTotals,
} from "./types.js";
export {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  effectiveInputTokens,
  type LevelReportRow,
  type SemanticForcedReportRow,
  semanticForcedReportRows,
  usageReportRows,
} from "./usage-report.js";

/** The durable telemetry store for a project (JSONL backend at P0). */
export function openTelemetryStore(projectDir: string): TelemetryStore {
  return new JsonlTelemetryStore(projectDir);
}

/**
 * Persist a pipeline event. `nowIso` is injected (the store never reads the
 * clock) — callers pass `new Date().toISOString()`. Fire-and-forget safe.
 */
export function recordPipelineEvent(
  store: TelemetryStore,
  event: PipelineEvent,
  nowIso: string,
): Promise<void> {
  const telemetryEvent: TelemetryEvent = {
    ts: nowIso,
    projectId: event.projectId,
    level: event.level,
    requestTokens: event.requestTokens,
    stageSavings: event.stageSavings,
    ccrRefsStored: event.ccrRefsStored,
  };
  return store.record(telemetryEvent);
}

/**
 * Persist a CCR retrieval event (the `expand` MCP tool's retrieve() path,
 * verification-notes §25). Durable so retrieval counts survive process exit
 * and cross the proxy/MCP-server process split — retrieval happens in the
 * MCP server process, which never sees the proxy's in-memory compression
 * counters. `nowIso` is injected like {@link recordPipelineEvent}. A
 * retrieval isn't a pipeline run (no policy, no token savings), so `level`
 * is an unused placeholder and `kind: "retrieval"` keeps it out of
 * aggregate()'s `requests` count.
 */
export function recordRetrieval(
  store: TelemetryStore,
  projectId: string,
  nowIso: string,
  count = 1,
): Promise<void> {
  const telemetryEvent: TelemetryEvent = {
    ts: nowIso,
    projectId,
    level: 0,
    kind: "retrieval",
    stageSavings: {},
    ccrRefsStored: 0,
    ccrRefsRetrieved: count,
  };
  return store.record(telemetryEvent);
}

/**
 * Persist one sampled upstream `usage` block (R1.1 — net-of-cache A/B input,
 * verification-notes §30-37). `nowIso` is injected like
 * {@link recordPipelineEvent}. Not a pipeline run (`kind: "usage"` keeps it
 * out of aggregate()'s `requests`/gross-token counts, same as `recordRetrieval`
 * does for `kind: "retrieval"`); rolled up separately by
 * `TelemetryStore.aggregateUsageByLevel`.
 */
export function recordUsageEvent(
  store: TelemetryStore,
  event: {
    readonly projectId: string;
    readonly level: number;
    readonly usage: ResponseUsage;
    /**
     * R2.6: whether `compression.force_semantic_on_caching` was on for this
     * proxy run. Static per-run, not per-request — see
     * {@link TelemetryEvent.semanticForced}. Defaults to `false`.
     */
    readonly semanticForced?: boolean;
  },
  nowIso: string,
): Promise<void> {
  const usage: UsageTotals = {
    inputTokens: event.usage.inputTokens,
    cacheCreationInputTokens: event.usage.cacheCreationInputTokens,
    cacheReadInputTokens: event.usage.cacheReadInputTokens,
    outputTokens: event.usage.outputTokens,
  };
  const telemetryEvent: TelemetryEvent = {
    ts: nowIso,
    projectId: event.projectId,
    level: event.level,
    kind: "usage",
    stageSavings: {},
    ccrRefsStored: 0,
    usage,
    semanticForced: event.semanticForced ?? false,
  };
  return store.record(telemetryEvent);
}

/**
 * Persist one `avoidedUpstream` sample: input tokens avoided by R2.2's
 * proxy-side context substitution, output tokens avoided by R2.3's
 * local-answer sub-mode (spec Decision 24, verification-notes §62), or both.
 * `nowIso` is injected like {@link recordPipelineEvent}. Not a pipeline run
 * (`kind: "avoidedUpstream"` keeps it out of aggregate()'s
 * `requests`/gross-token counts, same as `recordRetrieval` and
 * `recordUsageEvent`); rolled up separately by
 * `TelemetryStore.aggregateAvoidedUpstream`. Callers should skip this call
 * entirely when both counts are 0 (nothing to record).
 */
export function recordAvoidedUpstream(
  store: TelemetryStore,
  projectId: string,
  nowIso: string,
  inputTokensAvoided: number,
  outputTokensAvoided = 0,
): Promise<void> {
  const telemetryEvent: TelemetryEvent = {
    ts: nowIso,
    projectId,
    level: 0,
    kind: "avoidedUpstream",
    stageSavings: {},
    ccrRefsStored: 0,
    avoidedUpstreamInputTokens: inputTokensAvoided,
    avoidedUpstreamOutputTokens: outputTokensAvoided,
  };
  return store.record(telemetryEvent);
}

/** StatsSource (E3 seam) backed by durable telemetry. */
export function telemetryStatsSource(store: TelemetryStore): {
  readonly kind: string;
  readonly note: string;
  stats(projectId?: string): Promise<CompressionStats>;
} {
  return {
    kind: "telemetry",
    note: "Durable per-project savings recorded across sessions (telemetry store).",
    stats: (projectId?: string) => store.aggregate(projectId),
  };
}
