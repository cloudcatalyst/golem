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
import { JsonlTelemetryStore } from "./jsonl-store.js";
import type { TelemetryEvent, TelemetryStore } from "./types.js";

export { JsonlTelemetryStore, telemetryFilePath } from "./jsonl-store.js";
export type { TelemetryEvent, TelemetryStore } from "./types.js";

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
