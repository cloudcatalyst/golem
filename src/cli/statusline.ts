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
  friendlyModelVersionLabel,
  localModelVersionLabel,
  resolveUpstreamDisplay,
  type UpstreamProvider,
} from "../providers/index.js";
import { servedModelFor } from "../proxy/index.js";
import { openTelemetryStore } from "../telemetry/index.js";
import { readCachedUpdateCheck, semverGt } from "../update/index.js";
import { golemDirExists, type LocalModelInfo, localModelInfoCached } from "./local-model.js";
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
  /** Resolved upstream provider (`openai`/`anthropic`/…) — shown when it adds info beyond the label. */
  readonly upstreamProvider?: string;
  /** Configured default model (e.g. `kimi-k3`), if any. */
  readonly upstreamModel?: string;
  /** Last model the proxy actually served (from served-model.json), if any. */
  readonly lastServedModel?: string;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  /** Session is waiting on the human (21b blocked-state), if known. */
  readonly blocked?: boolean;
  /** Whether the Golem proxy is actually running (pid-file check), if known. */
  readonly proxyRunning?: boolean;
  /** Whether a local model is reachable — renders "local+upstream" (Decision 30), if known and enabled. */
  readonly localModelReachable?: boolean;
  /** The concrete local coder model (e.g. `qwen2.5-coder:7b`), when reachable. */
  readonly localCoderModel?: string;
  /** Whether the `coder` MCP tool is enabled (`inference.local_coder_enabled`). */
  readonly localCoderEnabled?: boolean;
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

/**
 * The versioned upstream-model label for the one-liner — the live/served model
 * when known (`claude-opus-4-8[1m]` → `Opus 4.8`), else the configured default
 * shown verbatim (an explicit id like `kimi-k3`), or `undefined` when neither is
 * known (a plain Anthropic passthrough that has served nothing yet).
 */
function upstreamModelLabel(golem: GolemState): string | undefined {
  if (golem.lastServedModel !== undefined) return friendlyModelVersionLabel(golem.lastServedModel);
  return golem.upstreamModel;
}

/**
 * The one-liner destination, e.g. `local (Qwen 2.5) + anthropic (Opus 4.8)`.
 * Each backend carries its own `(model)` parenthetical (versioned label). The
 * `local (…)` segment is present only when a local model is reachable
 * (Decision 30 — Golem is then a local+upstream hybrid at any level); when the
 * local model is up but its id is unknown it degrades to a bare `local`. Model
 * parentheticals are omitted when the model isn't known.
 */
export function destinationLabel(golem: GolemState): string {
  const upstreamModel = upstreamModelLabel(golem);
  const upstreamSeg =
    upstreamModel !== undefined ? `${golem.upstreamLabel} (${upstreamModel})` : golem.upstreamLabel;
  if (golem.localCoderEnabled === false || golem.localModelReachable !== true) return upstreamSeg;
  const localVer =
    golem.localCoderModel !== undefined ? localModelVersionLabel(golem.localCoderModel) : "";
  const localSeg = localVer !== "" ? `local (${localVer})` : "local";
  return `${localSeg} + ${upstreamSeg}`;
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

/**
 * Pure renderer — the unit-tested core. The line is the compact one-liner:
 *
 *   ⬢ Golem · Balanced → local (Qwen 2.5) + anthropic (Opus 4.8)
 *
 * `_session` (Claude Code's per-turn context %, 5h quota, cost) is parsed and
 * captured by {@link parseSessionInput} but deliberately NOT rendered here yet:
 * those live signals need a legible one-liner treatment before they go back on
 * the line (deferred, 2026-07-24). Cumulative savings moved to the fuller
 * summary surfaces (VS Code hover / panel), where the token in→out detail fits.
 */
export function renderStatusLine(
  _session: SessionInput,
  golem: GolemState,
  options: RenderOptions = {},
): string {
  const color = options.color ?? false;
  const dim = ansi(2, color);
  const green = ansi(32, color);
  const cyan = ansi(36, color);
  const yellow = ansi(33, color);

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

  // Brand · Level → destination. The destination names each backend with its
  // own versioned model (`local (Qwen 2.5) + anthropic (Opus 4.8)`); `local` is
  // present only when a local model is reachable (Decision 30).
  parts.push(brand);
  parts.push(`${cyan(label)} ${dim("→")} ${cyan(destinationLabel(golem))}`);

  if (golem.blocked === true) parts.push(yellow("⏸ waiting"));
  if (golem.updateAvailable === true) parts.push(yellow("⇧ update"));

  return parts.join(dim(" · "));
}

/** Read Golem-side state (config + telemetry) for `dir`. Never throws. */
export async function collectGolemState(
  dir: string,
  opts: { localReachable?: (dir: string, baseUrl: string) => Promise<LocalModelInfo> } = {},
): Promise<GolemState> {
  let sliderLevel = 1;
  let label = upstreamLabel("https://api.anthropic.com");
  let ollamaBaseUrl = "http://localhost:11434";
  let coderEnabled = true;
  let provider: UpstreamProvider | undefined;
  let model: string | undefined;
  let activeAccount: string | null = null;
  try {
    const { settings } = await loadConfig({ projectDir: dir });
    sliderLevel = settings.slider.level;
    ollamaBaseUrl = settings.inference.ollama_base_url;
    coderEnabled = settings.inference.local_coder_enabled;
    // R6.2: reflect the ACTIVE account/provider the proxy actually fronts, not
    // just the top-level base URL (env-less resolution — the label needs no key).
    const upstream = resolveUpstreamDisplay(settings.proxy);
    label = providerUpstreamLabel(upstream.provider, upstream.baseUrl, upstream.accountId);
    provider = upstream.provider;
    model = upstream.model;
    activeAccount = upstream.accountId;
  } catch {
    // defaults
  }
  let state: GolemState = {
    sliderLevel,
    upstreamLabel: label,
    localCoderEnabled: coderEnabled,
    ...(provider !== undefined ? { upstreamProvider: provider } : {}),
    ...(model !== undefined ? { upstreamModel: model } : {}),
  };
  // Only probe the local model in a Golem project. The status line may be a
  // global Claude Code `statusLine` that runs in every project; probing (which
  // also caches to `.golem/state/`) unconditionally would both waste a per-turn
  // localhost round-trip and create a `.golem/` folder in repos that never
  // opted into Golem (reported 2026-07-22).
  if (await golemDirExists(dir)) {
    try {
      const probe = opts.localReachable ?? localModelInfoCached;
      const info = await probe(dir, ollamaBaseUrl);
      state = {
        ...state,
        localModelReachable: info.reachable,
        ...(info.coderModel !== undefined ? { localCoderModel: info.coderModel } : {}),
      };
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
    // R6.2: the model the proxy last served (cheap state-file read, no network) —
    // lets the line show the live/current model, falling back to the configured
    // one when nothing has been served yet (handled in renderStatusLine). Scoped
    // to the active account: a snapshot from the upstream we just switched AWAY
    // from would otherwise keep the previous model name on the line.
    try {
      const served = await servedModelFor(dir, activeAccount);
      if (served !== null) state = { ...state, lastServedModel: served.model };
    } catch {
      // no served-model state yet — leave unknown
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
