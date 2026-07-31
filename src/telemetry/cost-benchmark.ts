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

import {
  lookupModel,
  type ModelCatalog,
  type ModelCatalogEntry,
  priceUsage,
} from "./model-catalog.js";
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

/**
 * R8.8 — one model's billed tokens and, when the catalog knows its price, real
 * money. `model` is the id VERBATIM (Decision 49); `usd` is null for an unpriced
 * or ambiguous model, which is the R6.4 behaviour and never a wrong number.
 */
export interface ModelSpendRow {
  readonly model: string;
  readonly requests: number;
  readonly input_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly output_tokens: number;
  readonly usd: number | null;
  /**
   * How the catalog resolved the id — or why it did not.
   * `provider-unconfirmed` means the id resolved, but under a different provider
   * than the one that served it, so the price is the catalog's best and is
   * labelled as such rather than presented as verified.
   */
  readonly priced_from:
    | "exact"
    | "dated-snapshot"
    | "provider-unconfirmed"
    | "unpriced"
    | "unknown"
    | "ambiguous";
}

/** R8.8 — the money view: what the window cost, and what could not be priced. */
export interface SpendSummary {
  /** Per-model rows, biggest billed-token count first. Ids verbatim. */
  readonly by_model: readonly ModelSpendRow[];
  /** Sum of the priced rows. Null when nothing in the window could be priced. */
  readonly priced_usd: number | null;
  /** Usage samples that carried no model (pre-R8.8 events, or an unobservable upstream). */
  readonly unattributed_requests: number;
  /** Models seen on the wire that the catalog has no price for. Ids verbatim. */
  readonly unpriced_models: readonly string[];
  /** Where the prices came from, cited (`catalog.source`), plus its `as_of`. */
  readonly catalog_source: string;
  readonly catalog_as_of: string;
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
  /**
   * R8.8: real money, present only when a catalog was supplied. Absent → the
   * report is exactly R6.4's token-and-baselines view, which is the honest
   * degradation for a missing or stale catalog.
   */
  readonly spend?: SpendSummary;
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

/**
 * R8.8 — emitted only when a catalog was supplied. Spend is computed from SAMPLED
 * usage events at catalogued list prices; it is not an invoice, and a model the
 * catalog cannot price is reported as tokens with no money rather than estimated.
 */
const SPEND_NOTE =
  "Spend is computed from Golem's own sampled `usage` events at the catalogued list " +
  "price per model id — an estimate of this project's traffic, not a billing " +
  "statement. Unattributed samples and unpriced models are reported separately " +
  "rather than folded into the total.";

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Cents-level precision: below that the figure is noise, above it is false precision. */
function roundUsd(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * R8.8 — price the per-model billed totals, keeping every "we could not price
 * this" case visible instead of folding it into the money line.
 */
function buildSpend(
  catalog: ModelCatalog,
  modelAcc: ReadonlyMap<
    string,
    { model: string; provider: string | undefined; requests: number; usage: UsageTotals }
  >,
  unattributedRequests: number,
): SpendSummary {
  const rows: ModelSpendRow[] = [];
  const unpriced: string[] = [];
  let pricedTotal = 0;
  let anyPriced = false;

  for (const acc of modelAcc.values()) {
    const match = lookupModel(
      catalog,
      acc.model,
      acc.provider !== undefined ? { preferProvider: acc.provider } : undefined,
    );
    const entry: ModelCatalogEntry | null = match.entry;
    let usd: number | null = entry === null ? null : priceUsage(entry, acc.usage);
    let pricedFrom: ModelSpendRow["priced_from"];
    if (entry === null) {
      pricedFrom = match.how === "ambiguous" ? "ambiguous" : "unknown";
    } else if (usd === null) {
      pricedFrom = "unpriced";
    } else {
      pricedFrom = match.how;
    }
    if (usd === null) {
      unpriced.push(acc.model);
    } else {
      anyPriced = true;
      pricedTotal += usd;
      usd = roundUsd(usd);
    }
    rows.push({
      model: acc.model,
      requests: acc.requests,
      input_tokens: acc.usage.inputTokens,
      cache_creation_input_tokens: acc.usage.cacheCreationInputTokens,
      cache_read_input_tokens: acc.usage.cacheReadInputTokens,
      output_tokens: acc.usage.outputTokens,
      usd,
      priced_from: pricedFrom,
    });
  }

  const billed = (row: ModelSpendRow): number =>
    row.input_tokens +
    row.cache_creation_input_tokens +
    row.cache_read_input_tokens +
    row.output_tokens;
  rows.sort((a, b) => billed(b) - billed(a));

  return {
    by_model: rows,
    priced_usd: anyPriced ? roundUsd(pricedTotal) : null,
    unattributed_requests: unattributedRequests,
    unpriced_models: [...new Set(unpriced)],
    catalog_source: catalog.source,
    catalog_as_of: catalog.asOf,
  };
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
    /**
     * R8.8: price/context data. Omit to get R6.4's token-only report — the
     * degradation path when no catalog is available.
     */
    readonly catalog?: ModelCatalog;
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
  // R8.8: per-model billed totals, keyed `model provider` so the same id
  // under two providers is never silently merged at one of their prices.
  const modelAcc = new Map<
    string,
    { model: string; provider: string | undefined; requests: number; usage: UsageTotals }
  >();
  let unattributedUsageSamples = 0;

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
      case "usage": {
        if (ev.usage === undefined) break;
        const sample = ev.usage as UsageTotals;
        effInput += effectiveInputTokens(sample);
        if (ev.model === undefined || ev.model === "") {
          unattributedUsageSamples += 1;
          break;
        }
        const key = `${ev.model} ${ev.modelProvider ?? ""}`;
        const acc = modelAcc.get(key) ?? {
          model: ev.model,
          provider: ev.modelProvider,
          requests: 0,
          usage: {
            inputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            outputTokens: 0,
          },
        };
        acc.requests += 1;
        acc.usage = {
          inputTokens: acc.usage.inputTokens + sample.inputTokens,
          cacheCreationInputTokens:
            acc.usage.cacheCreationInputTokens + sample.cacheCreationInputTokens,
          cacheReadInputTokens: acc.usage.cacheReadInputTokens + sample.cacheReadInputTokens,
          outputTokens: acc.usage.outputTokens + sample.outputTokens,
        };
        modelAcc.set(key, acc);
        break;
      }
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

  const spend =
    opts.catalog === undefined
      ? undefined
      : buildSpend(opts.catalog, modelAcc, unattributedUsageSamples);

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
    ...(spend !== undefined ? { spend } : {}),
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
    notes: spend === undefined ? HONEST_SCOPE_NOTES : [...HONEST_SCOPE_NOTES, SPEND_NOTE],
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

  if (report.spend !== undefined) {
    const spend = report.spend;
    lines.push("  billed spend (per model, ids verbatim):");
    if (spend.by_model.length === 0) {
      lines.push("    (no usage sample in this window carried a model)");
    }
    for (const row of spend.by_model) {
      const money = row.usd === null ? `no price (${row.priced_from})` : `$${row.usd.toFixed(2)}`;
      lines.push(
        `    ${row.model}  ${row.requests} sample(s)  ` +
          `in ${row.input_tokens} / write ${row.cache_creation_input_tokens} / ` +
          `read ${row.cache_read_input_tokens} / out ${row.output_tokens} — ${money}` +
          // A priced row that was not an exact provider+id hit says so on the row
          // itself; the qualifier is part of the number, not a footnote.
          (row.usd !== null && row.priced_from !== "exact" ? ` [${row.priced_from}]` : ""),
      );
    }
    lines.push(
      spend.priced_usd === null
        ? "    priced total:            — (nothing in this window could be priced)"
        : `    priced total:            $${spend.priced_usd.toFixed(2)}`,
    );
    if (spend.unattributed_requests > 0) {
      lines.push(
        `    unattributed samples:    ${spend.unattributed_requests} (no model recorded — not priced)`,
      );
    }
    if (spend.unpriced_models.length > 0) {
      lines.push(`    unpriced models:         ${spend.unpriced_models.join(", ")}`);
    }
    lines.push(
      `    prices from:             ${spend.catalog_source} (as of ${spend.catalog_as_of})`,
    );
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
