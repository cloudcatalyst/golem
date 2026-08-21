/**
 * WS-E / Decision 21c — `golem statusline`: the terminal wrapper.
 *
 * Claude Code runs this every turn and renders whatever it prints under the
 * prompt (verification-notes §28). We merge Claude Code's per-session stdin
 * JSON (context %, cache-read hits, cost, rate limits) with Golem's own state
 * (slider, upstream, cumulative savings from A4 telemetry) into one compact
 * line, e.g.:
 *
 *   ⬢ Golem → ◆ foundry (gpt-5) · 🗜 lossless · ✂ full
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
import { type BlockKind, readSessionState, resolveBlock } from "../hooks/session-state.js";
import { isKnownWorker, KNOWN_WORKERS } from "../inference/workers.js";
import {
  type CompressionLevel,
  coerceCompressionLevel,
  compressionName,
} from "../interfaces/policy.js";
import {
  listTargets,
  resolveUpstreamDisplay,
  type UpstreamProvider,
  upstreamAssumesCaching,
  withDefaultTarget,
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
  /** R11.1: the compression DIAL, which since ADR-0004 is the only such number. */
  readonly compression: CompressionLevel;
  /**
   * R11.1 — `proxy.bypass_all`: nothing runs, redaction included (ADR-0004).
   * Read here because every surface that renders this state has to shout about
   * it, and they all read this shape.
   */
  readonly proxyBypassAll?: boolean;
  /**
   * §103 — the level the pipeline will ACTUALLY apply, when it differs from
   * `compression`. The status line runs on every prompt, so it is the surface a
   * user actually reads their configuration off: showing "Aggressive" here while
   * the pipeline ran lossless was the most-seen version of that misreport.
   * Absent → nothing is degraded and `compression` is the truth.
   */
  readonly effectiveLevel?: CompressionLevel;
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
  /**
   * R12.2 — what the block IS (`permission` / `question` / `idle`), when the
   * read model knows. A bare "waiting" cannot be acted on; the kind at least
   * says whether anyone is being asked anything.
   */
  readonly blockedKind?: BlockKind;
  /**
   * R12.2 — the tool under judgement, for a permission block. Only the NAME
   * reaches a status line: the argument can be a whole shell command, and this
   * is a one-line glance surface. The full text lives in the read model, which
   * is what the panel, the dashboard and (ADR-0006) a paired device read.
   */
  readonly blockedTool?: string;
  /** Whether the Golem proxy is actually running (pid-file check), if known. */
  readonly proxyRunning?: boolean;
  /** Decision 56: the bypass shim is serving (pipeline off, redaction still on). */
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
  readonly coderModel?: string;
  /**
   * Whether the `coder` MCP tool can actually be served. Since R9.23 removed
   * `inference.coder_enabled` the tool is always offered, so this reflects
   * whether something can serve it, not a user toggle.
   */
  readonly coderEnabled?: boolean;
  /**
   * R9.4 — the model behind `inference.coder_target`, when that is set and
   * resolves. Wins over {@link coderModel}: a configured target is what
   * `coder` will actually draft on, local or not.
   */
  /**
   * R9.4 — the model each tool worker will actually use, resolved. A worker
   * whose target does not resolve carries no `model` and is omitted from the
   * line: it fails closed on every dispatch, so naming a model would advertise
   * something that can never run.
   */
  readonly workers?: readonly {
    readonly worker: string;
    readonly model?: string;
    readonly gateway?: string;
  }[];
  /** A newer Golem is known available (from the cached update check), if known. */
  readonly updateAvailable?: boolean;
}

/**
 * The staleness rule moved to the read model in R12.2 (`src/hooks/session-state.ts`)
 * — it is a property of the blocked state, not of one renderer, and the dashboard
 * and this line had each been deriving it separately. Re-exported here because
 * this module was its published home.
 */
export { BLOCKED_STALE_MS, isBlockedFresh } from "../hooks/session-state.js";

/**
 * R12.2 — the blocked segment, or "" when nothing is waiting.
 *
 * **This is the SECOND of two copies.** The VS Code status bar's `blockedLabel`
 * (`vscode-extension/render.js`) is the other; the extension is plain CommonJS
 * and shares no module with this file. Change both together — the two surfaces a
 * user reads in the same window must say the same thing, which is what
 * `tests/unit/cli/statusline-parity.test.ts` exists to pin. Before R12.2 the CLI
 * printed `⏸ waiting` and the status bar printed nothing at all, and no fixture
 * visited that state.
 *
 * Only the tool NAME appears here; the argument a human must judge is in the read
 * model, for surfaces that have room for it.
 */
export function blockedLabel(state: {
  readonly blocked?: boolean;
  readonly blockedKind?: BlockKind;
  readonly blockedTool?: string;
}): string {
  if (state.blocked !== true) return "";
  if (state.blockedTool !== undefined && state.blockedTool !== "") {
    return `⏸ waiting: ${state.blockedTool}`;
  }
  return state.blockedKind === undefined ? "⏸ waiting" : `⏸ waiting (${state.blockedKind})`;
}

/** Human-facing name for a slider level, Title-cased ("balanced" → "Balanced"). */
export function levelName(level: CompressionLevel): string {
  return compressionName(level);
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
    case "llamacpp":
      // The project spells itself "llama.cpp"; the config token cannot carry the
      // dot, but the status line has no such constraint and should read the way
      // the user's own notes do.
      return "llama.cpp";
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
  /** The model the conversation itself runs on. */
  chat: "◆",
  /** The model `coder` drafts on. */
  coder: "✎",
  /** Fallback for a worker with no glyph of its own yet. */
  worker: "✦",
} as const;

/**
 * What joins the model segments of the destination (R11.6).
 *
 * Named because the VS Code status bar has to produce the same string and shares
 * no module with this file — `statusline-parity.test.ts` is what holds them
 * together, and a bare literal in two languages is the drift R10.24 existed to
 * end.
 */
export const MODEL_JOIN = " + ";

/** The glyph for a worker, falling back to the generic worker mark. */
function workerMark(worker: string): string {
  return (ROLE_MARKS as Record<string, string>)[worker] ?? ROLE_MARKS.worker;
}

/**
 * The worker rows to render. `collectGolemState` supplies these; a state built
 * without them (a direct caller, or a pre-R9.4 shape) falls back to the implicit
 * "coder runs on the local model" row, which is the behaviour that predates
 * worker targets.
 */
function workerRows(golem: GolemState): readonly { worker: string; model?: string }[] {
  if (golem.workers !== undefined) return golem.workers;
  if (golem.coderEnabled === false || golem.localModelReachable !== true) return [];
  const model =
    golem.coderModel !== undefined && golem.coderModel !== "" ? golem.coderModel : "local";
  return [{ worker: "coder", model }];
}

/**
 * The one-liner destination, naming the CHAT gateway (model) first and then each
 * worker that diverges from it:
 *
 *   `◆ openrouter (deepseek/deepseek-v4-flash) + ✎ ollama (qwen2.5-coder:7b)`
 *
 * R10.24 — the chat destination leads. It used to trail the worker list, so on
 * any machine with a local coder the arrow pointed at the DRAFTING model and the
 * model the conversation actually runs on was pushed to the end. The arrow means
 * "where this conversation goes"; whatever it touches first had better be that.
 *
 * R11.6 — ONE format for every model segment, and `+` between them.
 *
 * The chat model read `<gateway> (<model>)` while a worker read `<gateway>
 * <model>`, so two things of the same kind were spelled two ways on one line and
 * the parentheses looked like they meant something. They now share the format,
 * and a worker with no resolvable gateway falls back to the bare id rather than
 * inventing one.
 *
 * `+` because these segments are of the same kind — models this conversation
 * uses — where `·` separates DIFFERENT kinds (models · dials · brevity). Using
 * one glyph for both made the model list and the dial list read as one flat run
 * of fields. It also restores the reading R9.4's `local + upstream` had before
 * either end could be any target; what changed then was which models get named,
 * not that they are added together.
 *
 * Model ids stay verbatim (Decision 49). A worker whose target does not resolve
 * is omitted: it fails closed on every dispatch.
 */
export function destinationLabel(golem: GolemState): string {
  const chatModel = upstreamModelLabel(golem);
  const chatGateway = golem.upstreamLabel;
  const chatSeg = `${ROLE_MARKS.chat} ${chatGateway}${chatModel !== undefined ? ` (${chatModel})` : ""}`;
  const diverging = workerRows(golem)
    .filter((w) => w.model !== undefined && w.model !== "" && w.model !== chatModel)
    .map((w) => {
      const g = (w as { gateway?: string }).gateway;
      const model = w.model as string;
      return `${workerMark(w.worker)} ${g !== undefined && g !== "" ? `${g} (${model})` : model}`;
    });
  return [chatSeg, ...diverging].join(MODEL_JOIN);
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
 *   ⬢ Golem → ◆ anthropic (claude-opus-5[1m]) · ✎ qwen2.5-coder:7b · 🗜 lossless · ✂ full
 *
 * R10.24 — ONE canonical segment order, shared with the VS Code status bar:
 * brand, then the arrow and where traffic goes, then the dials. The two surfaces
 * used to disagree (the extension put the compression level BEFORE the arrow),
 * and `tests/unit/cli/statusline-parity.test.ts` now pins that they cannot drift
 * apart again.
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
  // R10.24 — the same four state words the VS Code status bar uses
  // (`proxyStateWord` in vscode-extension/render.js). The glyph and colour
  // already carried this, but only for a reader who can see colour: NO_COLOR, a
  // monochrome terminal or a screenshot flattened "off", "unwired" and "bypass"
  // into one hollow hexagon. Naming the state costs one word and removes the
  // guess.
  const stateWord =
    golem.proxyRunning === false
      ? "off"
      : golem.proxyInPath === false
        ? "unwired"
        : golem.proxyBypass === true
          ? "bypass"
          : "";
  // Lead with the brand + level NAME, and an icon that signals whether Golem is
  // actually carrying traffic: filled green hexagon when the proxy is running
  // with pipeline enabled, hollow-but-green when running but pipeline is off
  // (proxy still forwards, no redaction/compression).
  const active = golem.proxyRunning !== false;
  // R8.32: a running daemon nothing is pointed at. This outranks every other
  // state below — a green ⬢ beside "Aggressive" while traffic went straight to
  // the upstream is the most confident lie this line can tell, and it told it
  // from the pid file alone. Yellow, not dim: "off" is a resting state the user
  // chose, this is a misconfiguration they almost certainly did not.
  const unwired = golem.proxyInPath === false;
  // R10.24: the bypass shim serves and redacts, but runs no pipeline — so it is
  // HOLLOW, as the VS Code status bar has always drawn it. This line drew it
  // filled and green, i.e. identical to a fully-running pipeline, which is the
  // one thing Decision 56 exists to distinguish.
  const brand =
    unwired || golem.proxyBypass === true
      ? yellow("⬡ Golem")
      : active
        ? green("⬢ Golem")
        : dim("⬡ Golem");
  const inert = golem.effectiveLevel !== undefined && golem.effectiveLevel !== golem.compression;

  // Brand [state] → destination · dials
  // R10.24: the arrow rides WITH the brand rather than after a separator, so the
  // line reads "Golem -> destination" on both surfaces. The CLI used to emit
  // `⬢ Golem · → dest` and the status bar `⬢ Golem → dest`.
  const head = stateWord === "" ? brand : `${brand} ${yellow(stateWord)}`;
  parts.push(`${head} ${dim("→")} ${cyan(destinationLabel(golem))}`);

  // R10.24: the dials describe transforms the pipeline is applying, so they are
  // shown only when it is applying them. Off, unwired and bypass all run no
  // compression and no brevity stage; printing the configured dials there
  // advertises work that is not happening — the same misreport R8.32 and
  // Decision 56 each turned on, and the reason the VS Code bar hid brevity in
  // bypass. One rule now, both dials, both surfaces.
  if (stateWord === "") {
    const compLabel = levelName(
      inert ? (golem.effectiveLevel as CompressionLevel) : golem.compression,
    ).toLowerCase();
    parts.push(`${dim("🗜")} ${compLabel}`);
    parts.push(`${dim("✂")} ${golem.brevity ?? "off"}`);
  }
  const waiting = blockedLabel(golem);
  if (waiting !== "") parts.push(yellow(waiting));
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
  let compression: CompressionLevel = 1;
  let bypassAll = false;
  let brevity = "off";
  let label = upstreamLabel("https://api.anthropic.com");
  let ollamaBaseUrl = "http://localhost:11434";
  const coderEnabled = true;
  let providers: readonly LocalProviderEntry[] | undefined;
  let provider: UpstreamProvider | undefined;
  let model: string | undefined;
  let workerTargetModels: readonly { worker: string; model?: string }[] = [];
  let activeAccount: string | null = null;
  let effectiveLevel: CompressionLevel | undefined;
  let proxyPort: number | undefined;
  try {
    const { settings } = await loadConfig({ projectDir: dir });
    compression = coerceCompressionLevel(settings.compression.level);
    bypassAll = settings.proxy.bypass_all;
    proxyPort = settings.proxy.port;
    // R11.1: both dials are read straight from settings — there is no preset to
    // resolve against, which is the point of retiring the slider.
    brevity = settings.brevity.level;
    ollamaBaseUrl = settings.inference.ollama_base_url;

    providers = settings.inference.providers as readonly LocalProviderEntry[];
    // R9.4: `coder` may default to any declared target. Resolve it from settings
    // already in hand — no extra I/O on a per-prompt surface. An unknown id
    // resolves to nothing and the line falls back to the local model rather than
    // naming a target that does not exist; `golem status` is where the
    // misconfiguration is reported properly.
    // Resolved from settings already in hand — no extra I/O on a per-prompt
    // surface. A target that does not resolve yields no model, so the worker is
    // omitted from the line rather than advertised.
    const configured = settings.inference.worker_targets;
    workerTargetModels = Object.keys(configured)
      .filter((worker) => isKnownWorker(worker))
      .map((worker) => {
        const hit = listTargets(settings.proxy).find((t) => t.id === configured[worker]);
        return {
          worker,
          ...(hit?.model !== undefined ? { model: hit.model } : {}),
          // R11.6: the same label the chat segment gets, from the same function
          // — this used to pass the raw `accountId`, so a target with no account
          // rendered gateway-less while the chat side happily said "ollama" for
          // the identical provider.
          ...(hit !== undefined
            ? { gateway: providerUpstreamLabel(hit.provider, hit.baseUrl, hit.accountId) }
            : {}),
        };
      });
    // R6.2: reflect the ACTIVE account/provider the proxy actually fronts, not
    // just the top-level base URL (env-less resolution — the label needs no key).
    // R9.23: default_target moved from proxy to inference — spread it onto
    // the proxy settings so resolveUpstreamDisplay can find it.
    const upstream = resolveUpstreamDisplay(withDefaultTarget(settings));
    label = providerUpstreamLabel(upstream.provider, upstream.baseUrl, upstream.accountId);
    provider = upstream.provider;
    model = upstream.model;
    activeAccount = upstream.accountId;
    // §103. Pure computation on settings already loaded — no extra I/O, which is
    // the constraint that matters on a per-prompt surface. This is the ONE
    // remaining set-vs-ran gap (Decision 31), and it is a real one.
    const assumeCaching = upstreamAssumesCaching(upstream.provider);
    const eff = resolveEffectiveCompression({
      level: compression,
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
    compression,
    proxyBypassAll: bypassAll,
    brevity,
    upstreamLabel: label,
    coderEnabled: coderEnabled,
    ...(effectiveLevel !== undefined ? { effectiveLevel } : {}),
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
      const info = await probe(dir, ollamaBaseUrl, providers);
      state = {
        ...state,
        localModelReachable: info.reachable,
        ...(info.coderModel !== undefined ? { coderModel: info.coderModel } : {}),
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
      ...(pid?.shim === true ? { proxyBypass: true } : {}),
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
    // R12.2: resolved through the read model's own classifier rather than by
    // re-deriving staleness here. Only `waiting` lights the indicator — an
    // `abandoned` block (blocked, but nobody ever wrote again) self-heals off
    // this glance surface instead of sticking on forever, exactly as before,
    // while staying visible as a distinct status to readers with room for it.
    const resolved = resolveBlock(await readSessionState(dir));
    if (resolved.status === "waiting") {
      const s = resolved.state;
      state = {
        ...state,
        blocked: true,
        ...(s?.kind !== undefined ? { blockedKind: s.kind } : {}),
        ...(s?.tool !== undefined ? { blockedTool: s.tool.name } : {}),
      };
    }
  } catch {
    // no session state
  }
  // R9.4: assemble the per-worker models AFTER the local probe, since a worker
  // with no configured target falls back to the local model — which has to
  // actually be reachable to be worth naming.
  state = { ...state, workers: resolveWorkerModels(state, workerTargetModels) };

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

/**
 * One row per known worker: its configured target's model, or the local model
 * when it has no target. A worker with no usable backend carries no `model` and
 * is therefore omitted from the line — better to say nothing than to name a
 * model that cannot serve.
 */
function resolveWorkerModels(
  state: GolemState,
  configured: readonly { worker: string; model?: string }[],
): readonly { worker: string; model?: string }[] {
  const localModel =
    state.localModelReachable === true
      ? state.coderModel !== undefined && state.coderModel !== ""
        ? state.coderModel
        : "local"
      : undefined;
  return KNOWN_WORKERS.map((worker) => {
    // Only `coder` has an enable flag today; a future worker without one is
    // simply always offered.
    if (worker === "coder" && state.coderEnabled === false) return { worker };
    const hit = configured.find((c) => c.worker === worker);
    if (hit !== undefined) return hit;
    return { worker, ...(localModel !== undefined ? { model: localModel } : {}) };
  });
}

// Re-exported: callers have always imported `upstreamLabel` from here.
export { upstreamLabel } from "./upstream-display.js";
