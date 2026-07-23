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
 * prints a minimal `⬢ golem` and exits 0. It reads local config + telemetry and
 * does at most ONE bounded, cached local-model probe per minute (the doc's
 * "cache slow ops" guidance) so the line can show local+upstream.
 */

import path from "node:path";
import { loadConfig } from "../config/index.js";
import { readSessionState } from "../hooks/index.js";
import { VERSION } from "../index.js";
import type { SliderLevel } from "../interfaces/policy.js";
import {
  resolveActiveUpstream,
  resolveAuthScheme,
  type UpstreamProvider,
} from "../providers/index.js";
import { openTelemetryStore } from "../telemetry/index.js";
import { readCachedUpdateCheck, semverGt } from "../update/index.js";
import { golemDirExists, localModelReachableCached } from "./local-model.js";
import { isProcessAlive, readProxyPid } from "./proxy-daemon.js";
import { SLIDER_LEVEL_NAMES } from "./slider.js";

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
  /** Whether the Golem proxy is actually running (pid-file check), if known. */
  readonly proxyRunning?: boolean;
  /** Whether a local model is reachable — renders "local+upstream" (Decision 30), if known. */
  readonly localModelReachable?: boolean;
  /** A newer Golem is known available (from the cached update check), if known. */
  readonly updateAvailable?: boolean;
}

/**
 * A blocked flag older than this is treated as stale — the "waiting" indicator
 * clears itself rather than sticking on if the clearing hook never fired.
 */
export const BLOCKED_STALE_MS = 10 * 60_000;

/** Is a blocked-state timestamp recent enough to still show "waiting"? */
export function isBlockedFresh(ts: string, nowMs: number = Date.now()): boolean {
  const t = Date.parse(ts);
  return Number.isFinite(t) && nowMs - t >= 0 && nowMs - t < BLOCKED_STALE_MS;
}

/** Human-facing name for a slider level, Title-cased ("balanced" → "Balanced"). */
export function levelName(level: number): string {
  const raw = SLIDER_LEVEL_NAMES[level as SliderLevel] ?? `level ${level}`;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
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

/**
 * R6.2: the honest upstream label given the resolved provider + active account.
 * An active account shows its id (that's what the user switched to); otherwise a
 * translating provider (openai/ollama/gemini) shows its name, and the
 * Anthropic-family providers fall back to the URL-based {@link upstreamLabel}.
 */
export function providerUpstreamLabel(
  provider: UpstreamProvider,
  baseUrl: string,
  accountId: string | null,
): string {
  if (accountId !== null) return accountId;
  switch (provider) {
    case "openai":
      return "openai";
    case "ollama":
      return "ollama";
    case "gemini":
      return "gemini";
    default:
      return upstreamLabel(baseUrl); // anthropic / azure-foundry / openrouter / custom
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
  // Lead with the brand + level NAME, and an icon that signals whether Golem is
  // actually carrying traffic: filled green hexagon when the proxy is running,
  // hollow dim hexagon when it is off. Unknown (undefined) is treated as active
  // so we never falsely signal "off"; only a confirmed-dead proxy is hollow.
  const active = golem.proxyRunning !== false;
  const brand = active ? green("⬢ Golem") : dim("⬡ Golem");
  // "Passthrough" whenever Golem isn't transforming traffic: the proxy is down,
  // or it's running at level 0 (full bypass, Decision 30). Both read the same —
  // traffic passes straight through to the upstream, untransformed.
  const passthrough = !active || golem.sliderLevel === 0;
  const label = passthrough ? "Passthrough" : levelName(golem.sliderLevel);
  parts.push(`${brand}: ${cyan(label)}`);
  if (golem.blocked === true) parts.push(yellow("⏸ waiting"));
  if (golem.updateAvailable === true) parts.push(yellow("⇧ update"));

  // Cumulative Golem savings from telemetry.
  const before = golem.tokensBefore ?? 0;
  const after = golem.tokensAfter ?? 0;
  if (before > 0 && after <= before) {
    const pct = Math.round(((before - after) / before) * 100);
    parts.push(green(`saved ${pct}% (${fmtTokens(before)}→${fmtTokens(after)})`));
  }

  // Where traffic is (or, in passthrough/off, would be) fronting — shown in
  // every state as the configured destination. A reachable local model prefixes
  // "local+" since Golem is a local+upstream hybrid at any level (Decision 30).
  const dest = golem.localModelReachable
    ? `→local+${golem.upstreamLabel}`
    : `→${golem.upstreamLabel}`;
  parts.push(cyan(dest));

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
export async function collectGolemState(
  dir: string,
  opts: { localReachable?: (dir: string, baseUrl: string) => Promise<boolean> } = {},
): Promise<GolemState> {
  let sliderLevel = 1;
  let label = upstreamLabel("https://api.anthropic.com");
  let ollamaBaseUrl = "http://localhost:11434";
  try {
    const { settings } = await loadConfig({ projectDir: dir });
    sliderLevel = settings.slider.level;
    ollamaBaseUrl = settings.inference.ollama_base_url;
    // R6.2: reflect the ACTIVE account/provider the proxy actually fronts, not
    // just the top-level base URL (env-less resolution — the label needs no key).
    const { resolved } = resolveActiveUpstream(
      {
        legacy: {
          provider: settings.proxy.upstream_provider,
          base_url: settings.proxy.upstream_base_url,
          ...(settings.proxy.upstream_model !== undefined
            ? { model: settings.proxy.upstream_model }
            : {}),
          auth_scheme: resolveAuthScheme(
            settings.proxy.upstream_provider,
            settings.proxy.upstream_auth_scheme,
          ),
        },
        ...(settings.proxy.accounts !== undefined ? { accounts: settings.proxy.accounts } : {}),
        ...(settings.proxy.active_account !== undefined
          ? { activeAccount: settings.proxy.active_account }
          : {}),
        legacyApiKey: undefined,
      },
      {},
    );
    label = providerUpstreamLabel(resolved.provider, resolved.baseUrl, resolved.accountId);
  } catch {
    // defaults
  }
  let state: GolemState = { sliderLevel, upstreamLabel: label };
  // Only probe the local model in a Golem project. The status line may be a
  // global Claude Code `statusLine` that runs in every project; probing (which
  // also caches to `.golem/state/`) unconditionally would both waste a per-turn
  // localhost round-trip and create a `.golem/` folder in repos that never
  // opted into Golem (reported 2026-07-22).
  if (await golemDirExists(dir)) {
    try {
      const probe = opts.localReachable ?? localModelReachableCached;
      state = { ...state, localModelReachable: await probe(dir, ollamaBaseUrl) };
    } catch {
      // local-model probe is best-effort; leave the field unknown
    }
    // Update indicator: cached-check read only — NEVER a network call on the
    // per-turn status line. `golem update --check` (or the VS Code poll) refreshes it.
    try {
      const cached = await readCachedUpdateCheck(path.join(dir, ".golem", "state"));
      if (cached?.latest != null && semverGt(cached.latest, VERSION)) {
        state = { ...state, updateAvailable: true };
      }
    } catch {
      // no cached check yet — leave unknown
    }
  }
  // Is the proxy actually running? Pid-file + kill(pid,0) only — instant, no
  // network probe (the status line runs on every turn).
  try {
    const pid = await readProxyPid(dir);
    state = { ...state, proxyRunning: pid !== null && isProcessAlive(pid.pid) };
  } catch {
    // pid file unreadable — leave proxyRunning unknown
  }
  try {
    const session = await readSessionState(dir);
    // Only show "waiting" if the blocked flag is RECENT. A stale flag (the
    // UserPromptSubmit clear-hook didn't fire, or the session moved on / switched
    // models) self-heals instead of sticking on forever.
    if (session?.blocked === true && isBlockedFresh(session.ts)) {
      state = { ...state, blocked: true };
    }
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
