/**
 * WS-E E3 — `golem status` engine.
 *
 * Collects, without side effects:
 *   - the effective config with per-key provenance (E1 loader),
 *   - whether this project is wired to Golem (init.ts file checks),
 *   - whether the proxy answers on the configured port (short HTTP probe),
 *   - the effective slider level.
 *
 * JSON output keys are snake_case, matching the settings-file conventions.
 *
 * This module is the stable public surface: it declares the report types and
 * re-exports the two halves of the engine — `./status-collect.js` (I/O and
 * assembly) and `./status-render.js` (pure rendering) — so every existing call
 * site keeps importing from here.
 */

// Type-only imports (erased at runtime, so they cost nothing on the statusline
// path). The narrow specifiers match the ones ./status-collect.ts imports for
// value, where the barrel's `undici` cost is what rules it out.
import type { LimitPrediction } from "../proxy/limit-prediction.js";
import type { LocalModelInfo } from "./local-model.js";
import type { VscodeExtensionReport } from "./vscode-extension.js";

/** Decision 52 — one dial's state in the JSON report. */
export interface DialStatus {
  /** The configured value: `"auto"` or a pinned value. */
  readonly setting: string;
  /** The value in force once the slider preset is applied. */
  readonly effective: string;
  /** True when the slider is NOT driving this dial. */
  readonly pinned: boolean;
  readonly layer: string;
  readonly source?: string;
}

/** One effective setting: value + which layer supplied it. */
export interface ConfigKeyStatus {
  readonly value: unknown;
  readonly layer: string;
  /** File path or env var name behind the layer (absent for defaults). */
  readonly source?: string;
}

export interface StatusReport {
  readonly version: string;
  readonly project_dir: string;
  readonly initialized: {
    readonly overall: boolean;
    readonly claude_settings: boolean;
    readonly mcp_registered: boolean;
    readonly skills: boolean;
    readonly golem_settings: boolean;
  };
  /**
   * R9.12 — can a cache-served WebFetch render GREEN *in the session that is
   * actually running*? Three separate facts, because they fail for different
   * reasons and the fix differs: whether the endpoint is up, whether the settings
   * name our CA, and whether THIS process inherited it. The last one is the only
   * one that decides the colour, and no settings file can prove it (§112: the
   * variable is read once at startup, so a correct settings file plus no restart
   * still means red).
   */
  readonly webfetch_green?: {
    /** The loopback endpoint has published coordinates (proxy daemon is up). */
    readonly endpoint: boolean;
    /** `.claude/settings.json` names our CA in its `env` block. */
    readonly wired: boolean;
    /** `NODE_EXTRA_CA_CERTS` in THIS process names our CA — restart-sensitive. */
    readonly trusted: boolean;
    /** Set when something else owns the variable — we never overwrite it (§121-C). */
    readonly foreign_ca?: string;
  };
  readonly proxy: {
    readonly port: number;
    readonly url: string;
    readonly reachable: boolean;
    /**
     * R8.32 — who owns `.claude/settings.json`'s `ANTHROPIC_BASE_URL`:
     * `"golem"` (us), `"foreign"` (another gateway — never touched), `"none"`.
     */
    readonly wiring?: "golem" | "foreign" | "none";
    /** The base URL actually wired, whoever owns it. Null when there is none. */
    readonly wiring_base_url?: string | null;
    /**
     * R8.32 — the question `reachable` was mistaken for: is Golem actually
     * carrying this project's traffic? `reachable && wiring === "golem"`.
     * A reachable proxy with no wiring pointing at it serves nothing.
     */
    readonly in_path?: boolean;
    /**
     * R9.8 — file the detached daemon's stdout/stderr are appended to. Optional
     * so an older renderer degrades rather than breaks. Before R9.8 the daemon
     * spawned with `stdio: "ignore"` and every proxy diagnostic was discarded.
     */
    readonly log?: string;
    /**
     * The build the RUNNING daemon was started from, when it can be known.
     * Absent when nothing is running, or when something holds the port without
     * a pid file.
     */
    readonly running_version?: string;
    /**
     * True when the running daemon is not this build. It still answers probes
     * and still reports `reachable`, but it serves the code AND the config it
     * started with — so a rebuild or a settings change since then has not
     * reached it. Restart with `golem proxy restart`.
     */
    readonly stale?: boolean;
  };
  /**
   * The active upstream's non-secret identity (R6.2 display): the account /
   * provider / base URL / configured model the proxy fronts, plus the
   * last-served model when the proxy has recorded one. Derived from the same
   * account resolution the proxy uses (`resolveUpstreamDisplay`), so it reflects
   * the ACTIVE account, not just the top-level base URL.
   */
  readonly upstream: {
    readonly provider: string;
    /** Active account id, or null when the legacy top-level config is in use. */
    readonly account: string | null;
    readonly base_url: string;
    /** Configured default model, or null for a byte-faithful Anthropic upstream. */
    readonly default_model: string | null;
    /**
     * Last model the proxy actually served **on this account** (from
     * served-model.json), if any. Absent right after an account switch, until the
     * new upstream serves something — a snapshot from the previous upstream is
     * dropped rather than reported as the current model.
     */
    readonly last_served_model?: string | null;
    /** When that model was served (ISO), if known. */
    readonly last_served_at?: string | null;
  };
  /**
   * R9.2 — one row per configured target, present only when the registry holds
   * more than the synthetic default (i.e. when the proxy is actually routing).
   *
   * The spec's 21e correctness rail is that **the responding model is always
   * visible**. With N targets served concurrently, a single `upstream` block
   * cannot satisfy that: it reports one model while others are serving. These
   * rows say which target served what, and when.
   */
  readonly targets?: readonly {
    readonly id: string;
    readonly provider: string;
    readonly base_url: string;
    readonly model: string | null;
    readonly trust: string;
    readonly account: string | null;
    /** True for the target that serves requests naming none. */
    readonly is_default: boolean;
    /** What this target last actually served, if it has served anything. */
    readonly last_served_model?: string;
    readonly last_served_at?: string;
  }[];
  readonly slider: {
    readonly level: number;
    readonly name: string;
    readonly layer: string;
    readonly source?: string;
  };
  /**
   * Decision 52 — the two dials the slider is a preset over. `pinned` is the
   * field that matters: when true the slider is NOT driving that dial, and every
   * surface must say so rather than implying the slider is in charge.
   */
  readonly dials: {
    readonly brevity: DialStatus;
    readonly compression: DialStatus;
  };
  /**
   * §103: what the compression level ACTUALLY does on the configured upstream, as
   * opposed to what it is set to. Levels 2–3 collapse to level 1 on a
   * prompt-caching upstream (Decision 31), so reporting the nominal level alone
   * told the user "aggressive" while the pipeline ran lossless.
   */
  readonly effective_compression: {
    readonly nominal: number;
    readonly nominal_name: string;
    readonly effective: number;
    readonly effective_name: string;
    readonly degraded: boolean;
    readonly reason?: string;
  };
  /**
   * R10.19: `compression.headroom_config` keys that cannot reach Headroom.
   * Reported here rather than only from the adapter, which runs too late (and,
   * on a caching upstream, never) to tell anyone.
   */
  readonly unreachable_headroom_config?: readonly string[];
  /** Dotted `section.key` -> effective value + provenance. */
  readonly config: Readonly<Record<string, ConfigKeyStatus>>;
  /**
   * Whether a local model (Ollama) is reachable, and whether the `coder` MCP
   * tool is enabled. When reachable AND enabled, Golem is a local+upstream
   * hybrid — the local model is available via the `coder` MCP tool at any slider
   * level (Decision 30/31) — and `coder_model` names the concrete model that
   * role runs at this machine's hardware tier.
   */
  readonly local_model: {
    readonly reachable: boolean;
    /**
     * The model local tiered inference would use (e.g. `qwen2.5-coder:7b`) when
     * reachable. R9.10: this is the LOCAL runtime's model, which is only what
     * `coder` reaches when no worker target is configured — see `workers`.
     */
    readonly model?: string;
    /** The endpoint the local runtime was probed at (`inference.ollama_base_url`). */
    readonly base_url: string;
  };
  /**
   * R9.4/R9.10 — one row per tool worker, naming where its next dispatch goes.
   *
   * **Top-level, not under `local_model`.** A worker routes to any target since
   * R9.3, so reporting `claude-sonnet-5` inside a block called `local_model` was
   * a contradiction in one object. Optional so a renderer that predates the move
   * degrades rather than breaks.
   *
   * R10.8: every known worker gets a row, whether or not it has a
   * `worker_targets` entry, and `route` says which step of the resolution chain
   * produced `target`. Before R10.8 an absent row meant "uses local tiered
   * inference"; it no longer can, because an unrouted worker now resolves
   * through `inference.default_target` to the harness's own upstream.
   */
  readonly workers?: readonly {
    readonly worker: string;
    readonly target: string;
    /**
     * Which step chose `target`: an explicit `worker_targets` entry (`worker`),
     * `inference.default_target`, or the harness default upstream (`harness`).
     */
    readonly route?: string;
    /** The target's model. Absent when the target does not resolve. */
    readonly model?: string;
    /** True when `target` names an id in no registry — the worker fails closed. */
    readonly target_unknown?: boolean;
    /** R9.10: false when this worker's target is not local — the honest bit. */
    readonly local?: boolean;
  }[];
  /**
   * Update status, from the LAST cached `golem update --check` (read-only, no
   * network here — status must never hang). Absent until a check has run.
   */
  readonly update?: {
    readonly available: boolean;
    readonly current: string;
    readonly latest: string | null;
  };
  /**
   * Usage-limit prediction, from the proxy's last observed
   * `anthropic-ratelimit-unified-*` headers (`.golem/state/limit-state.json`).
   * Absent until the proxy has seen those headers at least once. `stale` is true
   * when the reading is too old to trust (the header feed has gone cold — e.g.
   * the active account doesn't emit them), which is exactly when the snooze
   * auto-park goes blind, so it's surfaced as a warning too.
   */
  readonly limits?: {
    readonly five_hour_utilization: number;
    readonly seven_day_utilization?: number;
    readonly reset_at: string | null;
    readonly observed_at: string;
    readonly age_minutes: number;
    readonly stale: boolean;
    /** Whether the snooze auto-park is ENFORCING (persistent deny) vs advisory. */
    readonly enforced: boolean;
    /**
     * R9.2 — the target whose response carried these headers, when routing is on.
     * A prediction is a statement about ONE target, never about "the limit".
     */
    readonly source_target?: string | null;
    /**
     * R9.2 — configured targets that have never produced rate-limit headers, so
     * this reading says NOTHING about them. Only some providers emit
     * `anthropic-ratelimit-unified-*` at all; without naming them, one target's
     * utilization silently reads as coverage for all of them, and the auto-park
     * is blind for every target on this list.
     */
    readonly unmonitored_targets?: readonly string[];
  };
  /**
   * R9.16 — how the deployed VS Code extension compares with the one this Golem
   * ships. Absent when there is nothing to say (no VS Code, or no bundled
   * source), so the JSON stays quiet on machines this cannot apply to.
   */
  readonly vscode?: VscodeExtensionReport;
  readonly warnings: readonly string[];
}

export interface StatusOptions {
  readonly projectDir: string;
  /** CLI version string to report. */
  readonly version: string;
  /** Proxy probe timeout; keep short — status must never hang. */
  readonly probeTimeoutMs?: number;
  /** R9.16: VS Code extensions dir; null means "no VS Code". Tests inject. */
  readonly vscodeExtensionsDir?: string | null;
  /** Test injection (forwarded to loadConfig). */
  readonly userDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test injection for the local-model probe (avoids real network in tests). */
  readonly localProbe?: (projectDir: string, baseUrl: string) => Promise<LocalModelInfo>;
  /** Test injection for the limit-prediction read; default reads `limit-state.json`. */
  readonly readLimit?: (projectDir: string) => Promise<LimitPrediction | null>;
  /** Injected clock (epoch ms) for the prediction-freshness age; default `Date.now()`. */
  readonly now?: () => number;
}

// The engine itself, re-exported so `./status.js` stays the one import path.
export {
  collectStatus,
  LIMIT_STALE_WARNING,
  probeProxy,
  REDACTION_OFF_WARNING,
} from "./status-collect.js";
export { renderLimits, renderStatus } from "./status-render.js";
// Re-exported for the callers that have always imported them from here.
export { renderUpstream, upstreamLabel } from "./upstream-display.js";
