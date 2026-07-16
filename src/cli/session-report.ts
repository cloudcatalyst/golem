/**
 * R5.2 (WS-F10 / spec 21c) — the ONE consolidated session-state read model.
 *
 * Before R5.2 the sidecar state was split across two divergent shapes: the
 * dashboard's savings-focused `DashboardSnapshot` (`src/dashboard/server.ts`)
 * and the status line's liveness-focused `GolemState` (`src/cli/statusline.ts`).
 * Terminal, dashboard, VS Code panel, and the future 21b remote app must not
 * diverge, so this module is the single documented, zod-described payload every
 * renderer reads:
 *
 *   proxy reachability + upstream identity · slider level (+ redaction-off flag)
 *   · local-model reachability · blocked/waiting flag · cumulative savings +
 *   per-stage attribution · CCR + per-tool usage · on-disk storage sizes.
 *
 * It composes the already-shipped pieces (`collectGolemState`, `collectStats`,
 * `getSliderInfo`, telemetry) rather than re-deriving them, and is fully
 * defensive — any single source failing degrades that field, never the whole
 * report. Nothing here opens a network surface; that is 21b's later guarded step.
 */

import { z } from "zod";
import { AUTONOMY_LEVELS, type AutonomyLevel, readAutonomyLevel } from "../autonomy/index.js";
import { readSessionState } from "../hooks/index.js";
import { openTelemetryStore, type ToolUsageStats } from "../telemetry/index.js";
import { statsSourceForCli } from "./mcp-compression.js";
import { getSliderInfo } from "./slider.js";
import { collectStats, type StatsReport } from "./stats.js";
import { collectGolemState, type GolemState, isBlockedFresh, upstreamLabel } from "./statusline.js";
import { type GolemStorageSizes, golemStorageSizes } from "./storage-size.js";

/**
 * The consolidated sidecar payload (snake_case — it is also the JSON API shape
 * served at the dashboard's `/api/state`). `null` on a liveness field means
 * "unknown / not probed", distinct from a confirmed `false`.
 */
export interface SessionStateReport {
  readonly project_dir: string;
  /** ISO-8601 timestamp the report was assembled. */
  readonly generated_at: string;
  readonly proxy: {
    /** true=pid alive, false=confirmed dead, null=unknown. */
    readonly running: boolean | null;
    /** Short upstream label the proxy fronts (anthropic / foundry / host). */
    readonly upstream: string;
  };
  readonly slider: {
    readonly level: number;
    readonly name: string;
    /**
     * Level 0 is a FULL bypass — redaction is OFF (spec Decision 30). Surfaced
     * loudly so every renderer can warn, per the CLAUDE.md hard rule.
     */
    readonly redaction_off: boolean;
  };
  readonly local_model: {
    /** true=reachable, false=probed-unreachable, null=unknown. */
    readonly reachable: boolean | null;
  };
  /** R5.4 — the cruise-control autonomy level (surfaced per ADR-0002). */
  readonly autonomy: {
    readonly level: AutonomyLevel;
  };
  readonly blocked: {
    /** Session is waiting on the human (fresh 21b blocked flag). */
    readonly waiting: boolean;
    readonly reason?: string;
  };
  /** Cumulative savings + per-stage/CCR/tool attribution (the `golem stats` shape). */
  readonly savings: StatsReport;
  readonly storage: GolemStorageSizes;
}

// --- zod contract (validated at the HTTP boundary; internal code trusts types) ---

const stageReportSchema = z.object({
  tokens_before: z.number(),
  tokens_after: z.number(),
  tokens_saved: z.number(),
});

const toolUsageReportSchema = z.object({
  calls: z.number(),
  total_duration_ms: z.number(),
  total_result_bytes: z.number(),
  draft_chars: z.number(),
});

const statsReportSchema = z.object({
  source: z.string(),
  project_id: z.string().nullable(),
  requests: z.number(),
  tokens_before: z.number(),
  tokens_after: z.number(),
  tokens_saved: z.number(),
  per_stage: z.record(stageReportSchema),
  ccr_refs_stored: z.number(),
  ccr_refs_retrieved: z.number(),
  tool_usage: z.record(toolUsageReportSchema).optional(),
  note: z.string(),
});

export const sessionStateReportSchema = z.object({
  project_dir: z.string(),
  generated_at: z.string(),
  proxy: z.object({
    running: z.boolean().nullable(),
    upstream: z.string(),
  }),
  slider: z.object({
    level: z.number(),
    name: z.string(),
    redaction_off: z.boolean(),
  }),
  local_model: z.object({
    reachable: z.boolean().nullable(),
  }),
  autonomy: z.object({
    level: z.enum(AUTONOMY_LEVELS),
  }),
  blocked: z.object({
    waiting: z.boolean(),
    reason: z.string().optional(),
  }),
  savings: statsReportSchema,
  storage: z.object({
    ccr_bytes: z.number(),
    knowledge_bytes: z.number(),
    telemetry_bytes: z.number(),
    webcache_bytes: z.number(),
  }),
});

/** Injection seams for tests; all default to the real collectors. */
export interface CollectReportOptions {
  readonly nowIso?: string;
  /** Override the liveness collector (avoids the real local-model probe in tests). */
  readonly collectState?: (dir: string) => Promise<GolemState>;
}

/**
 * Assemble the consolidated report for `dir`. Never throws: each source is
 * guarded and degrades to a safe default (unknown liveness → null, empty
 * savings, zero storage) so a status read is always answerable.
 */
export async function collectSessionStateReport(
  dir: string,
  opts: CollectReportOptions = {},
): Promise<SessionStateReport> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const collectState = opts.collectState ?? collectGolemState;
  const [golem, slider, savings, storage, session, autonomyLevel] = await Promise.all([
    collectState(dir).catch(() => null),
    getSliderInfo({ projectDir: dir }).catch(() => null),
    collectSavings(dir),
    golemStorageSizes(dir),
    readSessionState(dir).catch(() => null),
    readAutonomyLevel(dir).catch(() => "manual" as AutonomyLevel),
  ]);

  const level = slider?.level ?? golem?.sliderLevel ?? 1;
  const name = slider?.name ?? levelFallbackName(level);
  const waiting = session?.blocked === true && isBlockedFresh(session.ts);

  return {
    project_dir: dir,
    generated_at: nowIso,
    proxy: {
      running: golem?.proxyRunning ?? null,
      upstream: golem?.upstreamLabel ?? upstreamLabel("https://api.anthropic.com"),
    },
    slider: { level, name, redaction_off: level === 0 },
    local_model: { reachable: golem?.localModelReachable ?? null },
    autonomy: { level: autonomyLevel },
    blocked: {
      waiting,
      ...(waiting && session?.reason !== undefined ? { reason: session.reason } : {}),
    },
    savings,
    storage,
  };
}

/** The savings sub-report, using the same telemetry-preferring source as `golem stats`. */
async function collectSavings(dir: string): Promise<StatsReport> {
  try {
    let toolUsage: ToolUsageStats | undefined;
    try {
      toolUsage = await openTelemetryStore(dir).aggregateToolUsage();
    } catch {
      toolUsage = undefined;
    }
    return await collectStats(await statsSourceForCli(dir), undefined, toolUsage);
  } catch {
    return emptyStats();
  }
}

function emptyStats(): StatsReport {
  return {
    source: "unavailable",
    project_id: null,
    requests: 0,
    tokens_before: 0,
    tokens_after: 0,
    tokens_saved: 0,
    per_stage: {},
    ccr_refs_stored: 0,
    ccr_refs_retrieved: 0,
    note: "stats unavailable",
  };
}

function levelFallbackName(level: number): string {
  return ["passthrough", "lossless", "balanced", "aggressive"][level] ?? `level ${level}`;
}
