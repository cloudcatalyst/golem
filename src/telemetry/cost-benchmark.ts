/**
 * R6.4 — cost-governance benchmark (spec Decision 21f).
 *
 * A PURE, read-only composition of EXISTING telemetry events into a report
 * framed against Claude Code's "Manage costs effectively" doc
 * (https://code.claude.com/docs/en/costs — re-verified 2026-07-23,
 * verification-notes §72). It adds no new capture: it folds the R1.1 net-of-cache
 * `usage` events, the R2.2/R2.3 `avoidedUpstream` events, the CCR store activity,
 * and the R4.3 per-tool `tool` events that are already recorded.
 *
 * Honest scoping is the whole point (Decision 23/31, verification-notes §72):
 * this measures GOLEM's own contribution, not Claude Code's `/usage` per-user
 * billing (which Golem never parses); the doc's baselines are Anthropic's stated
 * starting points, not a delta Golem claims against them; and on caching
 * upstreams lossless compression is ~0%, so the levers reported are CCR offload,
 * local drafting, and avoided-upstream — never gross-token compression.
 *
 * No clock reads inside the pure functions — `nowMs` is injected, matching the
 * telemetry store's "the store never reads the clock" convention.
 */

import type { TelemetryEvent, UsageTotals } from "./types.js";
import { effectiveInputTokens } from "./usage-report.js";

/**
 * Claude Code cost-doc baselines, carried as REFERENCE constants (not a claimed
 * delta). Re-verified against the live doc on 2026-07-23 (verification-notes
 * §72); update `as_of` and the figures if the doc moves again.
 */
export const COST_DOC_BASELINES = {
  source: "https://code.claude.com/docs/en/costs",
  as_of: "2026-07-23",
  /** "average cost is around $13 per developer per active day". */
  avg_usd_per_dev_per_active_day: 13,
  /** "$150-250 per developer per month". */
  usd_per_dev_per_month_low: 150,
  usd_per_dev_per_month_high: 250,
  /** "costs remaining below $30 per active day for 90% of users". */
  under_usd_per_active_day_for_90pct: 30,
  /** "Agent teams use approximately 7x more tokens … when teammates run in plan mode". */
  agent_team_token_multiplier: 7,
} as const;

/** The doc's own `/usage` time toggle: last 24 hours vs last 7 days (plus all-time). */
export type BenchWindow = "24h" | "7d" | "all";

const DAY_MS = 86_400_000;

/** Recommended CLAUDE.md ceiling from the doc ("Aim to keep CLAUDE.md under 200 lines"). */
export const CLAUDE_MD_RECOMMENDED_MAX_LINES = 200;

/**
 * Earliest event timestamp (ms) included in `window`, or null for all-time.
 * `24h`/`7d` are `nowMs` minus the window; `all` imposes no lower bound.
 */
export function windowStartMs(window: BenchWindow, nowMs: number): number | null {
  switch (window) {
    case "24h":
      return nowMs - DAY_MS;
    case "7d":
      return nowMs - 7 * DAY_MS;
    case "all":
      return null;
  }
}

/** Golem's measured contribution over the window (honestly-scoped buckets). */
export interface GolemSavings {
  readonly requests: number;
  readonly ccr_refs_stored: number;
  readonly ccr_refs_retrieved: number;
  /** Sum of `coder` draft characters — output the paid model didn't generate. */
  readonly drafted_locally_chars: number;
  /** `drafted_locally_chars / 4`, rounded — a rough token estimate. */
  readonly drafted_locally_tokens_est: number;
  /** R2.2 context-substitution input tokens elided (already in the web-cache). */
  readonly avoided_upstream_input_tokens: number;
  /** R2.3 local-answer output tokens the upstream never had to generate. */
  readonly avoided_upstream_output_tokens: number;
  /**
   * Sum of net-of-cache effective input tokens across sampled `usage` events
   * (cache write 1.25×, read 0.1× — the only honest input-cost signal, R1.1).
   */
  readonly net_of_cache_effective_input_tokens: number;
}

/** Per-tool attribution line — the doc's "% of total" metric, over Golem's own MCP tools. */
export interface ToolAttribution {
  readonly calls: number;
  readonly total_duration_ms: number;
  readonly total_result_bytes: number;
  readonly draft_chars: number;
  /** This tool's share of all tool calls in the window, percent (1 decimal). */
  readonly share_pct: number;
}

export interface CostBenchmarkReport {
  readonly source: string;
  readonly project_id: string | null;
  readonly window: BenchWindow;
  /** ISO timestamp of the window's lower bound, or null for all-time. */
  readonly window_start: string | null;
  readonly generated_at: string;
  readonly golem_savings: GolemSavings;
  readonly tool_attribution: Readonly<Record<string, ToolAttribution>>;
  readonly baselines: typeof COST_DOC_BASELINES;
  /** Cheap checkable technique the doc recommends: keep CLAUDE.md lean. */
  readonly claude_md?: {
    readonly lines: number;
    readonly recommended_max: number;
    readonly lean: boolean;
  };
  readonly notes: readonly string[];
}

/** Fixed honest-scoping notes emitted on every report (verification-notes §72). */
const HONEST_SCOPE_NOTES: readonly string[] = [
  "Measures Golem's own contribution (CCR offload, local drafting, avoided-upstream, " +
    "net-of-cache usage) — NOT a replacement for Claude Code's /usage per-user billing, " +
    "which is computed from local session history Golem never parses.",
  "Baselines are Anthropic's stated starting points (see baselines.source), not a delta " +
    "Golem claims to achieve against them.",
  "On caching upstreams, lossless compression is ~0% (spec Decision 23/31); the honest " +
    "savings levers are CCR offload, local drafting (coder), and avoidedUpstream.",
];

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Fold recorded telemetry events into a {@link CostBenchmarkReport}. Pure:
 * `nowMs` and `claudeMdLines` are injected. Events outside the window or the
 * requested project are ignored; unparseable timestamps are skipped.
 */
export function buildCostBenchmark(
  events: readonly TelemetryEvent[],
  opts: {
    readonly projectId?: string;
    readonly window: BenchWindow;
    readonly nowMs: number;
    readonly claudeMdLines?: number;
  },
): CostBenchmarkReport {
  const start = windowStartMs(opts.window, opts.nowMs);

  let requests = 0;
  let ccrStored = 0;
  let ccrRetrieved = 0;
  let draftedChars = 0;
  let avoidedInput = 0;
  let avoidedOutput = 0;
  let effInput = 0;

  const toolAcc = new Map<
    string,
    { calls: number; durationMs: number; resultBytes: number; draftChars: number }
  >();

  for (const ev of events) {
    if (opts.projectId !== undefined && ev.projectId !== opts.projectId) continue;
    if (start !== null) {
      const t = Date.parse(ev.ts);
      if (Number.isNaN(t) || t < start) continue;
    }

    switch (ev.kind ?? "request") {
      case "request":
        requests += 1;
        ccrStored += ev.ccrRefsStored;
        break;
      case "retrieval":
        ccrRetrieved += ev.ccrRefsRetrieved ?? 0;
        break;
      case "usage":
        if (ev.usage !== undefined) effInput += effectiveInputTokens(ev.usage as UsageTotals);
        break;
      case "avoidedUpstream":
        avoidedInput += ev.avoidedUpstreamInputTokens ?? 0;
        avoidedOutput += ev.avoidedUpstreamOutputTokens ?? 0;
        break;
      case "tool": {
        if (ev.tool === undefined) break;
        const acc = toolAcc.get(ev.tool) ?? {
          calls: 0,
          durationMs: 0,
          resultBytes: 0,
          draftChars: 0,
        };
        acc.calls += 1;
        acc.durationMs += ev.toolDurationMs ?? 0;
        acc.resultBytes += ev.toolResultBytes ?? 0;
        acc.draftChars += ev.toolDraftChars ?? 0;
        draftedChars += ev.toolDraftChars ?? 0;
        toolAcc.set(ev.tool, acc);
        break;
      }
    }
  }

  let totalToolCalls = 0;
  for (const acc of toolAcc.values()) totalToolCalls += acc.calls;

  const tool_attribution: Record<string, ToolAttribution> = {};
  for (const [tool, acc] of toolAcc) {
    tool_attribution[tool] = {
      calls: acc.calls,
      total_duration_ms: acc.durationMs,
      total_result_bytes: acc.resultBytes,
      draft_chars: acc.draftChars,
      share_pct: totalToolCalls > 0 ? round1((acc.calls / totalToolCalls) * 100) : 0,
    };
  }

  return {
    source: "telemetry",
    project_id: opts.projectId ?? null,
    window: opts.window,
    window_start: start === null ? null : new Date(start).toISOString(),
    generated_at: new Date(opts.nowMs).toISOString(),
    golem_savings: {
      requests,
      ccr_refs_stored: ccrStored,
      ccr_refs_retrieved: ccrRetrieved,
      drafted_locally_chars: draftedChars,
      drafted_locally_tokens_est: Math.round(draftedChars / 4),
      avoided_upstream_input_tokens: avoidedInput,
      avoided_upstream_output_tokens: avoidedOutput,
      net_of_cache_effective_input_tokens: Math.round(effInput),
    },
    tool_attribution,
    baselines: COST_DOC_BASELINES,
    ...(opts.claudeMdLines !== undefined
      ? {
          claude_md: {
            lines: opts.claudeMdLines,
            recommended_max: CLAUDE_MD_RECOMMENDED_MAX_LINES,
            lean: opts.claudeMdLines <= CLAUDE_MD_RECOMMENDED_MAX_LINES,
          },
        }
      : {}),
    notes: HONEST_SCOPE_NOTES,
  };
}

/** Human-readable rendering (the default, non---json output). */
export function renderCostBenchmark(report: CostBenchmarkReport): string {
  const scope = report.project_id === null ? "all projects" : `project ${report.project_id}`;
  const windowLabel =
    report.window === "all" ? "all time" : `last ${report.window === "24h" ? "24h" : "7d"}`;
  const s = report.golem_savings;
  const lines: string[] = [];
  lines.push(`Golem cost-governance benchmark (${scope}, ${windowLabel})`);
  lines.push("  Golem's measured contribution:");
  lines.push(`    requests measured:        ${s.requests}`);
  lines.push(
    `    CCR offload:              ${s.ccr_refs_stored} stored / ${s.ccr_refs_retrieved} retrieved`,
  );
  lines.push(
    `    drafted locally (coder):  ${s.drafted_locally_chars} chars (~${s.drafted_locally_tokens_est} tokens)`,
  );
  lines.push(
    `    avoided upstream:         ${s.avoided_upstream_input_tokens} in / ${s.avoided_upstream_output_tokens} out tokens`,
  );
  lines.push(`    net-of-cache eff. input:  ${s.net_of_cache_effective_input_tokens} tokens`);

  const tools = Object.entries(report.tool_attribution);
  if (tools.length > 0) {
    lines.push("  local-tool attribution (share of tool calls):");
    for (const [tool, t] of tools.sort((a, b) => b[1].calls - a[1].calls)) {
      lines.push(`    ${tool.padEnd(12)} ${t.calls} call(s), ${t.share_pct}%`);
    }
  }

  if (report.claude_md !== undefined) {
    const verdict = report.claude_md.lean ? "lean" : "OVER the recommended max";
    lines.push(
      `  CLAUDE.md: ${report.claude_md.lines} lines (recommend ≤ ${report.claude_md.recommended_max}) — ${verdict}`,
    );
  }

  lines.push("  Anthropic cost-doc baselines (reference, not a claimed delta):");
  lines.push(
    `    ~$${report.baselines.avg_usd_per_dev_per_active_day}/dev/active-day, ` +
      `$${report.baselines.usd_per_dev_per_month_low}-${report.baselines.usd_per_dev_per_month_high}/dev/month, ` +
      `<$${report.baselines.under_usd_per_active_day_for_90pct}/day for 90% ` +
      `(${report.baselines.source}, as of ${report.baselines.as_of})`,
  );
  lines.push("");
  for (const note of report.notes) lines.push(`note: ${note}`);
  return `${lines.join("\n")}\n`;
}
