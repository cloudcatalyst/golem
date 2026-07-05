/**
 * WS-E / Decision 21c — `golem statusline`: the terminal wrapper.
 *
 * Claude Code runs this every turn and renders whatever it prints under the
 * prompt (verification-notes §28). We merge Claude Code's per-session stdin
 * JSON (context %, cache-read hits, cost, rate limits) with Golem's own state
 * (slider, upstream, cumulative savings from A4 telemetry) into one compact
 * line, e.g.:
 *
 *   ⬢ golem →foundry · L1 · saved 34% · ctx 8% · 5h 23% · $0.012
 *
 * Hard rule for this command: it must NEVER throw or hang — a broken status
 * line would disrupt the editor. Everything is defensive; on any error it
 * prints a minimal `⬢ golem` and exits 0. It also avoids slow work (no network
 * probe) per the doc's performance warning; it only reads local config +
 * telemetry.
 */

import { loadConfig } from "../config/index.js";
import { readSessionState } from "../hooks/index.js";
import { openTelemetryStore } from "../telemetry/index.js";

/** Fields we pull from Claude Code's status-line stdin JSON (all optional). */
export interface SessionInput {
  readonly contextUsedPct?: number | undefined;
  readonly cacheReadTokens?: number | undefined;
  readonly costUsd?: number | undefined;
  readonly fiveHourPct?: number | undefined;
  readonly sevenDayPct?: number | undefined;
  readonly modelName?: string | undefined;
  readonly cwd?: string | undefined;
}

/** Golem-side state for the line. */
export interface GolemState {
  readonly sliderLevel: number;
  readonly upstreamLabel: string;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  /** Session is waiting on the human (21b blocked-state), if known. */
  readonly blocked?: boolean;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Defensively extract the fields we care about from the status-line stdin. */
export function parseSessionInput(raw: string): SessionInput {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(j)) return {};
  const ctx = isRecord(j.context_window) ? j.context_window : {};
  const cost = isRecord(j.cost) ? j.cost : {};
  const model = isRecord(j.model) ? j.model : {};
  const ws = isRecord(j.workspace) ? j.workspace : {};
  const rl = isRecord(j.rate_limits) ? j.rate_limits : {};
  const fiveHour = isRecord(rl.five_hour) ? rl.five_hour : {};
  const sevenDay = isRecord(rl.seven_day) ? rl.seven_day : {};
  const usage = isRecord(ctx.current_usage) ? ctx.current_usage : {};
  return {
    contextUsedPct: num(ctx.used_percentage),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    costUsd: num(cost.total_cost_usd),
    fiveHourPct: num(fiveHour.used_percentage),
    sevenDayPct: num(sevenDay.used_percentage),
    modelName: typeof model.display_name === "string" ? model.display_name : undefined,
    cwd: typeof ws.current_dir === "string" ? ws.current_dir : undefined,
  };
}

/** Short label for the configured upstream (foundry / anthropic / host). */
export function upstreamLabel(url: string): string {
  try {
    const host = new URL(url).host.toLowerCase();
    if (host.includes("azure")) return "foundry";
    if (host === "api.anthropic.com") return "anthropic";
    if (host.includes("openrouter")) return "openrouter";
    return host;
  } catch {
    return "upstream";
  }
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

// --- minimal ANSI (honors NO_COLOR); ESC built at runtime, no literal byte ---
type Colorize = (s: string) => string;
const ESC = String.fromCharCode(27);
function ansi(code: number, enabled: boolean): Colorize {
  return (s: string) => (enabled ? `${ESC}[${code}m${s}${ESC}[0m` : s);
}

export interface RenderOptions {
  readonly color?: boolean;
}

/** Pure renderer — the unit-tested core. */
export function renderStatusLine(
  session: SessionInput,
  golem: GolemState,
  options: RenderOptions = {},
): string {
  const color = options.color ?? false;
  const dim = ansi(2, color);
  const green = ansi(32, color);
  const cyan = ansi(36, color);
  const yellow = ansi(33, color);
  const red = ansi(31, color);

  const parts: string[] = [];
  parts.push(`${green("⬢ golem")} ${cyan(`→${golem.upstreamLabel}`)}`);
  if (golem.blocked === true) parts.push(yellow("⏸ waiting"));
  parts.push(`L${golem.sliderLevel}`);

  // Cumulative Golem savings from telemetry.
  const before = golem.tokensBefore ?? 0;
  const after = golem.tokensAfter ?? 0;
  if (before > 0 && after <= before) {
    const pct = Math.round(((before - after) / before) * 100);
    parts.push(green(`saved ${pct}% (${fmtTokens(before)}→${fmtTokens(after)})`));
  }

  // Live session context usage.
  if (session.contextUsedPct !== undefined) {
    const c = session.contextUsedPct >= 80 ? red : session.contextUsedPct >= 50 ? yellow : dim;
    parts.push(c(`ctx ${Math.round(session.contextUsedPct)}%`));
  }

  // Quota (5h window is the one people hit).
  if (session.fiveHourPct !== undefined) {
    const c = session.fiveHourPct >= 80 ? red : session.fiveHourPct >= 50 ? yellow : dim;
    parts.push(c(`5h ${Math.round(session.fiveHourPct)}%`));
  }

  if (session.costUsd !== undefined) {
    parts.push(dim(`$${session.costUsd.toFixed(session.costUsd < 1 ? 3 : 2)}`));
  }

  return parts.join(dim(" · "));
}

/** Read Golem-side state (config + telemetry) for `dir`. Never throws. */
export async function collectGolemState(dir: string): Promise<GolemState> {
  let sliderLevel = 1;
  let upstream = "https://api.anthropic.com";
  try {
    const { settings } = await loadConfig({ projectDir: dir });
    sliderLevel = settings.slider.level;
    upstream = settings.proxy.upstream_base_url;
  } catch {
    // defaults
  }
  let state: GolemState = { sliderLevel, upstreamLabel: upstreamLabel(upstream) };
  try {
    const session = await readSessionState(dir);
    if (session?.blocked === true) state = { ...state, blocked: true };
  } catch {
    // no session state
  }
  try {
    const agg = await openTelemetryStore(dir).aggregate();
    if (agg.requests > 0) {
      return { ...state, tokensBefore: agg.tokensBefore, tokensAfter: agg.tokensAfter };
    }
  } catch {
    // no telemetry yet
  }
  return state;
}
