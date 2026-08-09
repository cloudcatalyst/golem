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

// Claude Code renders this line on EVERY prompt, so each import here is on a hot
// path: prefer the narrowest module over a barrel, and the read-only half of
// anything that also has a write path (verification-notes §86).
import path from "node:path";
// §103. Dependency-free pure module, so the per-prompt surface pays nothing to
// predict the compression gate (verification-notes §86).
import { resolveEffectiveCompression } from "../compression/effective-level.js";
import { loadConfig } from "../config/index.js";
// `../hooks/session-state.js`, not the `../hooks/index.js` barrel (~446ms — it
// pulls every hook handler) for one function.
import { readSessionState } from "../hooks/session-state.js";
import { resolveBrevity, resolveCompressionLevel, type SliderLevel } from "../interfaces/policy.js";
import {
  listTargets,
  resolveUpstreamDisplay,
  type UpstreamProvider,
  upstreamAssumesCaching,
} from "../providers/index.js";
// `../proxy/served-model.js`, not the `../proxy/index.js` barrel: the barrel reaches
// server.ts, which imports `undici` (~270ms). This function only reads a JSON file.
import { servedModelFor } from "../proxy/served-model.js";
import { openTelemetryStore } from "../telemetry/index.js";
import { readCachedUpdateCheck, semverGt } from "../update/index.js";
// `../version.js`, not `../index.js` (which also re-exports every interface).
import { VERSION } from "../version.js";
import type { ProviderEntry as LocalProviderEntry } from "./local-model.js";
import { golemDirExists, type LocalModelInfo, localModelInfoCached } from "./local-model.js";
import { isProcessAlive, readProxyPid } from "./proxy-daemon.js";
import { proxyBaseUrl, readWiringState } from "./proxy-wiring.js";
// `./slider-read.js`, not `./slider.js`: the latter imports `./init.js` for the
// write path (~426ms) and all that's wanted here is a lookup table.
import { SLIDER_LEVEL_NAMES } from "./slider-read.js";
// Shared with status.ts and the control-panel header; lives in its own module so
// rendering a label costs nothing to import (see upstream-display.ts).
import { upstreamLabel } from "./upstream-display.js";

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
  /**
   * §103 — the level the pipeline will ACTUALLY apply, when it differs from
   * `sliderLevel`. The status line runs on every prompt, so it is the surface a
   * user actually reads their configuration off: showing "Aggressive" here while
   * the pipeline ran lossless was the most-seen version of that misreport.
   * Absent → nothing is degraded and `sliderLevel` is the truth.
   */
  readonly effectiveLevel?: number;
  /**
   * Decision 52 — the effective brevity level ("off" when the dial is off).
   * Surfaced because brevity changes the model's own output style: an unexplained
   * terse assistant should always trace back to a visible dial.
   */
  readonly brevity?: string;
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
  /**
   * Decision 56: the listener is the redaction-only bypass shim rather than the
   * pipeline. Distinct from `proxyRunning: false` — traffic still flows and is
   * still redacted, so "off" would be a lie.
   */
  readonly proxyBypass?: boolean;
  /**
   * R8.32 — whether Claude Code is actually POINTED at the proxy
   * (`.claude/settings.json` `env.ANTHROPIC_BASE_URL`). Independent of
   * `proxyRunning`: the daemon can be up and healthy while the client talks
   * straight to the upstream, which is the one state this line used to render
   * as a confident green ⬢. Unknown (undefined) is treated as wired, so an
   * unreadable settings file never invents an alarm.
   */
  readonly proxyInPath?: boolean;
  /** Whether a local model is reachable — renders "local+upstream" (Decision 30), if known and enabled. */
  readonly localModelReachable?: boolean;
  /** The concrete local coder model (e.g. `qwen2.5-coder:7b`), when reachable. */
  readonly localCoderModel?: string;
  /** Whether the `coder` MCP tool is enabled (`inference.local_coder_enabled`). */
  readonly localCoderEnabled?: boolean;
  /**
   * R9.4 — the model behind `inference.coder_target`, when that is set and
   * resolves. Wins over {@link localCoderModel}: a configured target is what
   * `coder` will actually draft on, local or not.
   */
  readonly coderTargetModel?: string;
  /**
   * R9.4 — `inference.coder_target` is set but names an id in no registry.
   * `coder` then fails closed on every dispatch, so there is NO coder backend:
   * the line must not fall back to advertising the local model, which would name
   * a model that can never run.
   */
  readonly coderTargetUnknown?: boolean;
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
 * The upstream-model id for the one-liner — the live/served model when known
 * (`claude-opus-5[1m]`), else the configured default (an explicit id like
 * `kimi-k3`), or `undefined` when neither is known (a plain Anthropic
 * passthrough that has served nothing yet). Shown verbatim: the id as
 * configured/served, never a prettified family name (see
 * `providers/model-display.ts`).
 */
function upstreamModelLabel(golem: GolemState): string | undefined {
  return golem.lastServedModel ?? golem.upstreamModel;
}

/**
 * R9.4 — the role markers on the destination segment.
 *
 * **Placeholders: pick the final glyphs here.** They are deliberately the only
 * place either surface names a symbol, so changing them is one edit — but there
 * is a SECOND copy in `vscode-extension/render.js` (`ROLE_MARKS`), because the
 * extension is plain JS and shares no module with the CLI. Change both together;
 * a test pins that they agree.
 *
 * Keep them single-width. The status line is rendered every turn in a terminal
 * of unknown width, and a double-width glyph misaligns everything after it.
 */
export const ROLE_MARKS = {
  /** The model `coder` drafts on. */
  coder: "✎",
  /** The model the conversation itself runs on. */
  chat: "◆",
} as const;

/**
 * The model `coder` drafts on by default: the configured `inference.coder_target`
 * when set (R9.4), otherwise the local tiered model.
 *
 * `undefined` means "no coder backend to report" — the tool is disabled, or it
 * would use a local model that is not reachable. It must NOT fall back to
 * showing the chat model: claiming a coder backend that cannot serve a draft is
 * the R8.32 failure in miniature.
 */
function coderModelLabel(golem: GolemState): string | undefined {
  if (golem.localCoderEnabled === false) return undefined;
  // A target that resolves to nothing means `coder` fails closed on every
  // dispatch — no backend at all. Falling through to the local model would
  // advertise a model that can never run.
  if (golem.coderTargetUnknown === true) return undefined;
  // A configured target answers regardless of whether Ollama is up — it is not
  // the local model, so local reachability says nothing about it.
  if (golem.coderTargetModel !== undefined && golem.coderTargetModel !== "") {
    return golem.coderTargetModel;
  }
  if (golem.localModelReachable !== true) return undefined;
  return golem.localCoderModel !== undefined && golem.localCoderModel !== ""
    ? golem.localCoderModel
    : "local";
}

/**
 * The one-liner destination, naming the two models that actually matter now
 * that either end can be any target (R9.1–R9.4):
 *
 *   `✎ qwen2.5-coder:7b · ◆ claude-opus-5[1m]`
 *
 * **Flattened to one segment when both are the same model**, because printing
 * the same id twice under two symbols tells the reader nothing and costs the
 * width that the rest of the line needs:
 *
 *   `◆ claude-opus-5[1m]`
 *
 * The old shape (`local (…) + anthropic (…)`) hard-coded the assumption this
 * work removed — that drafting is local and only the upstream is a real choice.
 * Model ids stay verbatim (Decision 49): never a prettified family name.
 * When the chat model is unknown the segment degrades to the upstream label
 * alone, which is still true.
 */
export function destinationLabel(golem: GolemState): string {
  const chatModel = upstreamModelLabel(golem);
  const chatSeg = `${ROLE_MARKS.chat} ${chatModel ?? golem.upstreamLabel}`;
  const coderModel = coderModelLabel(golem);
  if (coderModel === undefined) return chatSeg;
  // Same model on both ends → one segment. Compare the ids, not the labels.
  if (chatModel !== undefined && coderModel === chatModel) return chatSeg;
  return `${ROLE_MARKS.coder} ${coderModel} · ${chatSeg}`;
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
 *   ⬢ Golem · Balanced → local (qwen2.5-coder:7b) + anthropic (claude-opus-5[1m])
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
  // Decision 56: the bypass shim IS listening and IS redacting, so it is neither
  // "running" nor "off". A hollow-but-green hexagon says carrying traffic,
  // pipeline off — the two states used to collapse into one misleading label.
  const bypass = golem.proxyBypass === true;
  // R8.32: a running daemon nothing is pointed at. This outranks every other
  // state below — a green ⬢ beside "Aggressive" while traffic went straight to
  // the upstream is the most confident lie this line can tell, and it told it
  // from the pid file alone. Yellow, not dim: "off" is a resting state the user
  // chose, this is a misconfiguration they almost certainly did not.
  const unwired = golem.proxyInPath === false;
  const brand = unwired
    ? yellow("⬡ Golem")
    : bypass
      ? green("⬡ Golem")
      : active
        ? green("⬢ Golem")
        : dim("⬡ Golem");
  // "Passthrough" whenever Golem isn't transforming traffic: the proxy is down,
  // it's unwired, it's the bypass shim, or it's running at level 0 (full
  // bypass, Decision 30).
  const passthrough = !active || bypass || unwired || golem.sliderLevel === 0;
  // §103: name the level that is RUNNING, not the one that was set. The nominal
  // level still gets said — as a badge below — but it must not be the headline
  // when the pipeline is doing something else.
  const inert = golem.effectiveLevel !== undefined && golem.effectiveLevel !== golem.sliderLevel;
  const label = unwired
    ? "Unwired"
    : bypass
      ? "Bypass"
      : passthrough
        ? "Passthrough"
        : levelName(inert ? (golem.effectiveLevel as number) : golem.sliderLevel);

  // Brand · Level → destination. The destination names each backend with its
  // own model id verbatim (`local (qwen2.5-coder:7b) + anthropic
  // (claude-opus-5[1m])`); `local` is present only when a local model is
  // reachable (Decision 30).
  parts.push(brand);
  parts.push(`${cyan(label)} ${dim("→")} ${cyan(destinationLabel(golem))}`);

  // Decision 52: brevity changes how the MODEL talks, so it must be visible
  // wherever Golem's state is — otherwise a terse assistant looks like a model
  // regression rather than a dial someone set. Shown only when active, so the
  // default (off) costs no width.
  // Decision 56: the bypass shim runs no brevity stage, so showing the CONFIGURED
  // dial here would advertise an output transform that is not happening — the
  // same class of dishonesty as labelling a served port "off".
  // R8.32: same reasoning as the shim — an unwired proxy runs no brevity stage,
  // so advertising the configured dial would describe a transform that is not
  // happening.
  if (golem.brevity !== undefined && golem.brevity !== "off" && !bypass && !unwired) {
    parts.push(yellow(`✂ ${golem.brevity}`));
  }
  // The set-but-inert level, said explicitly so the difference is visible rather
  // than merely absent. Costs width only in the degraded case.
  if (inert && !passthrough) {
    parts.push(yellow(`⚠ ${golem.sliderLevel} inert`));
  }
  if (golem.blocked === true) parts.push(yellow("⏸ waiting"));
  if (golem.updateAvailable === true) parts.push(yellow("⇧ update"));

  return parts.join(dim(" · "));
}

/** Read Golem-side state (config + telemetry) for `dir`. Never throws. */
export async function collectGolemState(
  dir: string,
  opts: {
    localReachable?: (
      dir: string,
      baseUrl: string,
      providers?: readonly LocalProviderEntry[],
    ) => Promise<LocalModelInfo>;
  } = {},
): Promise<GolemState> {
  let sliderLevel = 1;
  let brevity = "off";
  let label = upstreamLabel("https://api.anthropic.com");
  let ollamaBaseUrl = "http://localhost:11434";
  let coderEnabled = true;
  let providers: readonly LocalProviderEntry[] | undefined;
  let provider: UpstreamProvider | undefined;
  let model: string | undefined;
  let coderTargetModel: string | undefined;
  let coderTargetUnknown = false;
  let activeAccount: string | null = null;
  let effectiveLevel: number | undefined;
  let proxyPort: number | undefined;
  try {
    const { settings } = await loadConfig({ projectDir: dir });
    sliderLevel = settings.slider.level;
    proxyPort = settings.proxy.port;
    // Resolved here rather than imported from dials.ts: the status line runs on
    // every prompt, and this is a two-field lookup on settings we already have.
    brevity =
      settings.brevity.level === "auto"
        ? resolveBrevity(settings.slider.level, "auto")
        : settings.brevity.level;
    ollamaBaseUrl = settings.inference.ollama_base_url;
    coderEnabled = settings.inference.local_coder_enabled;
    providers = settings.inference.providers as readonly LocalProviderEntry[];
    // R9.4: `coder` may default to any declared target. Resolve it from settings
    // already in hand — no extra I/O on a per-prompt surface. An unknown id
    // resolves to nothing and the line falls back to the local model rather than
    // naming a target that does not exist; `golem status` is where the
    // misconfiguration is reported properly.
    const coderTarget = settings.inference.coder_target;
    if (coderTarget !== undefined) {
      const hit = listTargets(settings.proxy).find((t) => t.id === coderTarget);
      if (hit === undefined) coderTargetUnknown = true;
      else coderTargetModel = hit.model ?? undefined;
    }
    // R6.2: reflect the ACTIVE account/provider the proxy actually fronts, not
    // just the top-level base URL (env-less resolution — the label needs no key).
    const upstream = resolveUpstreamDisplay(settings.proxy);
    label = providerUpstreamLabel(upstream.provider, upstream.baseUrl, upstream.accountId);
    provider = upstream.provider;
    model = upstream.model;
    activeAccount = upstream.accountId;
    // §103. Pure computation on settings already loaded — no extra I/O, which is
    // the constraint that matters on a per-prompt surface. The compression DIAL,
    // not the slider, is what the pipeline reads (Decision 52).
    const assumeCaching = upstreamAssumesCaching(upstream.provider);
    // The dial is stored as a string enum ("auto" | "1" | "2" | "3"); coerce the
    // same way dials.ts does rather than inventing a second convention.
    const pin = settings.compression.level;
    const dialLevel = resolveCompressionLevel(
      settings.slider.level,
      pin === "auto" ? "auto" : (Number(pin) as SliderLevel),
    );
    const eff = resolveEffectiveCompression({
      level: dialLevel,
      upstreamBaseUrl: upstream.baseUrl,
      ...(assumeCaching !== undefined && { assumeCachingUpstream: assumeCaching }),
      headroomSidecar: settings.compression.headroom_sidecar,
      forceSemanticOnCaching: settings.compression.force_semantic_on_caching,
    });
    if (eff.degraded) effectiveLevel = eff.effective;
  } catch {
    // defaults
  }
  let state: GolemState = {
    sliderLevel,
    brevity,
    upstreamLabel: label,
    localCoderEnabled: coderEnabled,
    ...(effectiveLevel !== undefined ? { effectiveLevel } : {}),
    ...(provider !== undefined ? { upstreamProvider: provider } : {}),
    ...(model !== undefined ? { upstreamModel: model } : {}),
    ...(coderTargetModel !== undefined ? { coderTargetModel } : {}),
    ...(coderTargetUnknown ? { coderTargetUnknown: true } : {}),
  };
  // Only probe the local model in a Golem project. The status line may be a
  // global Claude Code `statusLine` that runs in every project; probing (which
  // also caches to `.golem/state/`) unconditionally would both waste a per-turn
  // localhost round-trip and create a `.golem/` folder in repos that never
  // opted into Golem (reported 2026-07-22).
  if (await golemDirExists(dir)) {
    try {
      const probe = opts.localReachable ?? localModelInfoCached;
      const info = await probe(dir, ollamaBaseUrl, providers);
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
    const running = pid !== null && isProcessAlive(pid.pid);
    state = {
      ...state,
      proxyRunning: running,
      ...(running && pid?.shim === true ? { proxyBypass: true } : {}),
    };
    // R8.32 — the pid file only proves a daemon exists. Ask the other half of
    // the question: is Claude Code pointed at it? One small local JSON read, on
    // the same footing as the pid read above, so the 2s refresh stays cheap.
    // Only when running: a stopped proxy with live wiring is R8.31's case and
    // already renders as inactive.
    if (running && proxyPort !== undefined) {
      const wiring = await readWiringState(dir, proxyBaseUrl(proxyPort));
      state = { ...state, proxyInPath: wiring.owner === "golem" };
    }
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

// Re-exported: callers have always imported `upstreamLabel` from here.
export { upstreamLabel } from "./upstream-display.js";
