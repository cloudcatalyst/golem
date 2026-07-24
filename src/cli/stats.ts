/**
 * WS-E E3 — `golem stats` engine.
 *
 * The CLI (and dashboard) read savings through the thin {@link StatsSource}
 * seam rather than a concrete service, so A4's durable telemetry store
 * (src/telemetry/, built in parallel) can be plugged in later without
 * touching command code: it only has to expose `stats()` returning the frozen
 * CompressionStats shape plus a kind/note describing its history horizon.
 *
 * Until telemetry lands, {@link liveStatsSource} wraps the real A2
 * CompressionService (NativeLosslessCompression) — accurate per-stage
 * attribution, but in-memory per process, so a fresh CLI invocation starts
 * from zero. That caveat is surfaced as `note` in every report.
 */

import { NativeLosslessCompression } from "../compression/index.js";
import type { CompressionStats } from "../interfaces/compression.js";
import type { TelemetryEvent } from "../telemetry/index.js";
import {
  type BenchWindow,
  type ToolUsageStats,
  windowedStatsWithFallback,
} from "../telemetry/index.js";

/** Pluggable savings-stats provider (A4 telemetry implements this later). */
export interface StatsSource {
  /** Short machine tag for the provider ("live" now; "telemetry" with A4). */
  readonly kind: string;
  /** Human caveat about the data's history horizon; shown in reports. */
  readonly note: string;
  /** CompressionService-shaped stats, optionally scoped to one project. */
  stats(projectId?: string): Promise<CompressionStats>;
}

export const LIVE_STATS_NOTE =
  "Live compression-service counters for this process only; " +
  "durable per-project history starts when telemetry (task A4) lands.";

/** StatsSource over the real A2 lossless stage for `projectDir`'s CCR store. */
export function liveStatsSource(projectDir: string): StatsSource {
  const service = NativeLosslessCompression.forProjectDir(projectDir);
  return statsSourceFor(service, "live", LIVE_STATS_NOTE);
}

/** Wrap any CompressionService-stats provider as a StatsSource (tests, A4). */
export function statsSourceFor(
  service: { stats(projectId?: string): Promise<CompressionStats> },
  kind: string,
  note: string,
): StatsSource {
  return {
    kind,
    note,
    stats: (projectId) => (projectId === undefined ? service.stats() : service.stats(projectId)),
  };
}

/** One stage's token delta (snake_case for --json output). */
export interface StageReport {
  readonly tokens_before: number;
  readonly tokens_after: number;
  readonly tokens_saved: number;
}

/** R4.3 — one tool's local-usage line (snake_case for --json output). */
export interface ToolUsageReport {
  readonly calls: number;
  readonly total_duration_ms: number;
  readonly total_result_bytes: number;
  readonly draft_chars: number;
}

export interface StatsReport {
  readonly source: string;
  readonly project_id: string | null;
  readonly requests: number;
  readonly tokens_before: number;
  readonly tokens_after: number;
  readonly tokens_saved: number;
  readonly per_stage: Readonly<Record<string, StageReport>>;
  readonly ccr_refs_stored: number;
  readonly ccr_refs_retrieved: number;
  /** R4.3 — per-tool local-tool usage; absent when nothing was recorded. */
  readonly tool_usage?: Readonly<Record<string, ToolUsageReport>> | undefined;
  /** The savings window requested (24h/7d/all); absent for the all-time live source. */
  readonly window?: BenchWindow;
  /** The window that actually supplied the numbers after fallback (may be wider). */
  readonly window_applied?: BenchWindow;
  readonly note: string;
}

export async function collectStats(
  source: StatsSource,
  projectId?: string,
  toolUsage?: ToolUsageStats,
): Promise<StatsReport> {
  const stats = await source.stats(projectId);
  const perStage: Record<string, StageReport> = {};
  for (const [stage, delta] of Object.entries(stats.perStage)) {
    perStage[stage] = {
      tokens_before: delta.tokensBefore,
      tokens_after: delta.tokensAfter,
      tokens_saved: delta.tokensBefore - delta.tokensAfter,
    };
  }
  return {
    source: source.kind,
    project_id: stats.projectId,
    requests: stats.requests,
    tokens_before: stats.tokensBefore,
    tokens_after: stats.tokensAfter,
    tokens_saved: stats.tokensBefore - stats.tokensAfter,
    per_stage: perStage,
    ccr_refs_stored: stats.ccrRefsStored,
    ccr_refs_retrieved: stats.ccrRefsRetrieved,
    ...(toolUsageToReport(toolUsage) !== undefined
      ? { tool_usage: toolUsageToReport(toolUsage) }
      : {}),
    note: source.note,
  };
}

export const TELEMETRY_WINDOW_NOTE =
  "Durable per-project savings over a rolling window (telemetry store); " +
  "situational per spec Decision 23 — near-0% on cached Anthropic traffic.";

/**
 * A {@link StatsReport} scoped to a rolling savings window, folded from raw
 * timestamped telemetry events. Widens the window (24h → 7d → all) when the
 * requested one recorded nothing, and reports which window the numbers came from
 * so the surface can label it. `nowMs` is injected (never reads the clock).
 */
export function collectWindowedStats(
  events: readonly TelemetryEvent[],
  opts: {
    readonly window: BenchWindow;
    readonly nowMs: number;
    readonly projectId?: string;
    readonly toolUsage?: ToolUsageStats;
  },
): StatsReport {
  const { stats, windowApplied } = windowedStatsWithFallback(events, {
    preferred: opts.window,
    nowMs: opts.nowMs,
    ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
  });
  const perStage: Record<string, StageReport> = {};
  for (const [stage, delta] of Object.entries(stats.perStage)) {
    perStage[stage] = {
      tokens_before: delta.tokensBefore,
      tokens_after: delta.tokensAfter,
      tokens_saved: delta.tokensBefore - delta.tokensAfter,
    };
  }
  return {
    source: "telemetry",
    project_id: stats.projectId,
    requests: stats.requests,
    tokens_before: stats.tokensBefore,
    tokens_after: stats.tokensAfter,
    tokens_saved: stats.tokensBefore - stats.tokensAfter,
    per_stage: perStage,
    ccr_refs_stored: stats.ccrRefsStored,
    ccr_refs_retrieved: stats.ccrRefsRetrieved,
    ...(toolUsageToReport(opts.toolUsage) !== undefined
      ? { tool_usage: toolUsageToReport(opts.toolUsage) }
      : {}),
    window: opts.window,
    window_applied: windowApplied,
    note: TELEMETRY_WINDOW_NOTE,
  };
}

/** Convert telemetry {@link ToolUsageStats} to the snake_case report shape (undefined if empty). */
function toolUsageToReport(
  usage: ToolUsageStats | undefined,
): Record<string, ToolUsageReport> | undefined {
  if (usage === undefined) return undefined;
  const entries = Object.entries(usage.byTool);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(
    entries.map(([tool, u]) => [
      tool,
      {
        calls: u.calls,
        total_duration_ms: u.totalDurationMs,
        total_result_bytes: u.totalResultBytes,
        draft_chars: u.draftChars,
      },
    ]),
  );
}

/** Human-readable rendering (the default, non---json output). */
export function renderStats(report: StatsReport): string {
  const scope = report.project_id === null ? "all projects" : `project ${report.project_id}`;
  const lines: string[] = [];
  const windowLabel =
    report.window !== undefined
      ? `, ${report.window === report.window_applied ? report.window : `${report.window}→${report.window_applied}`}`
      : "";
  lines.push(`Golem savings (${scope}${windowLabel})`);
  lines.push(`  requests:       ${report.requests}`);
  lines.push(`  tokens before:  ${report.tokens_before}`);
  lines.push(`  tokens after:   ${report.tokens_after}`);
  lines.push(`  tokens saved:   ${report.tokens_saved}`);
  lines.push(
    `  CCR refs:       ${report.ccr_refs_stored} stored / ${report.ccr_refs_retrieved} retrieved`,
  );
  const stages = Object.entries(report.per_stage);
  if (stages.length > 0) {
    lines.push("  per stage:");
    for (const [stage, delta] of stages) {
      lines.push(
        `    ${stage.padEnd(12)} ${delta.tokens_before} -> ${delta.tokens_after} ` +
          `(saved ${delta.tokens_saved})`,
      );
    }
  }
  const tools = report.tool_usage === undefined ? [] : Object.entries(report.tool_usage);
  if (tools.length > 0) {
    lines.push("  local tools:");
    for (const [tool, u] of tools) {
      const avgMs = u.calls > 0 ? Math.round(u.total_duration_ms / u.calls) : 0;
      const drafted = u.draft_chars > 0 ? `, ~${Math.round(u.draft_chars / 4)} tokens drafted` : "";
      lines.push(`    ${tool.padEnd(12)} ${u.calls} call(s), avg ${avgMs}ms${drafted}`);
    }
  }
  lines.push("");
  lines.push(`note: ${report.note}`);
  return `${lines.join("\n")}\n`;
}
