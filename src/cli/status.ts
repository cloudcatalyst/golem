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
 */

import http from "node:http";
import path from "node:path";
import {
  type EffectiveCompression,
  resolveEffectiveCompression,
} from "../compression/effective-level.js";
import { loadConfig } from "../config/index.js";
import { STALE_AFTER_MS } from "../hooks/snooze-nudge.js";
import type { SliderLevel } from "../interfaces/policy.js";
import { resolveUpstreamDisplay, upstreamAssumesCaching } from "../providers/index.js";
// Narrow modules rather than `../proxy/index.js`: that barrel reaches server.ts,
// which imports `undici` (~270ms), and both of these only read a JSON file.
import { type LimitPrediction, readLimitState } from "../proxy/limit-prediction.js";
import { servedModelFor } from "../proxy/served-model.js";
import { readCachedUpdateCheck, semverGt } from "../update/index.js";
import { type DialInfo, getDialInfo } from "./dials.js";
import { golemInitStatus } from "./init.js";
import { type LocalModelInfo, probeAndCacheLocalModelInfo } from "./local-model.js";
import { getSliderInfo, SLIDER_LEVEL_NAMES, type SliderInfo } from "./slider.js";

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

// Pure display helpers live in ./upstream-display.js so the `golem` control panel can
// render an upstream label without loading this module (see that file).
import { renderUpstream } from "./upstream-display.js";

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
  readonly proxy: {
    readonly port: number;
    readonly url: string;
    readonly reachable: boolean;
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
    /** The `coder`/`drafter` model (e.g. `qwen2.5-coder:7b`) when reachable. */
    readonly coder_model?: string;
    /** Whether `inference.local_coder_enabled` is true (default). */
    readonly coder_enabled: boolean;
    /** The local (Ollama) base URL the probe targeted — for the hover summary's `Local:` line. */
    readonly base_url: string;
  };
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
  };
  readonly warnings: readonly string[];
}

export interface StatusOptions {
  readonly projectDir: string;
  /** CLI version string to report. */
  readonly version: string;
  /** Proxy probe timeout; keep short — status must never hang. */
  readonly probeTimeoutMs?: number;
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

const DEFAULT_PROBE_TIMEOUT_MS = 1_500;

/**
 * True when an HTTP server answers at all on `127.0.0.1:port` — any status
 * code counts (the proxy forwards upstream, so even an upstream error reply
 * proves the proxy itself is alive). Never rejects.
 */
export function probeProxy(
  port: number,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/", method: "GET", timeout: timeoutMs },
      (res) => {
        res.resume(); // drain; we only care that something answered
        resolve(true);
        req.destroy();
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

export async function collectStatus(options: StatusOptions): Promise<StatusReport> {
  const projectDir = path.resolve(options.projectDir);
  const { settings, provenance, warnings } = await loadConfig({
    projectDir,
    ...(options.userDir !== undefined && { userDir: options.userDir }),
    ...(options.env !== undefined && { env: options.env }),
  });

  const sliderOpts = {
    projectDir,
    ...(options.userDir !== undefined && { userDir: options.userDir }),
    ...(options.env !== undefined && { env: options.env }),
  };
  // R6.2 display: the ACTIVE account/provider/model the proxy fronts (not just
  // the top-level base URL). No network, no secret — see resolveUpstreamDisplay.
  // Resolved before the reads below because the last-served-model lookup is
  // scoped to this account (a snapshot from the previous upstream must not be
  // reported as the current model).
  const upstream = resolveUpstreamDisplay(settings.proxy);

  const localProbe = options.localProbe ?? probeAndCacheLocalModelInfo;
  const [init, reachable, slider, brevityDial, compressionDial, localInfo, servedModel] =
    await Promise.all([
      golemInitStatus(projectDir, settings.proxy.port),
      probeProxy(settings.proxy.port, options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
      getSliderInfo(sliderOpts),
      // Decision 52: the slider is a preset over two dials, so status must report
      // BOTH and say which of them the slider is actually driving.
      getDialInfo("brevity", sliderOpts),
      getDialInfo("compression", sliderOpts),
      localProbe(
        projectDir,
        settings.inference.ollama_base_url,
        settings.inference.providers,
      ).catch((): LocalModelInfo => ({ reachable: false })),
      servedModelFor(projectDir, upstream.accountId).catch(() => null),
    ]);

  // Update status from the cached check only (no network — never hang status).
  // Recompute "available" against the version we're actually running.
  const cachedUpdate = await readCachedUpdateCheck(path.join(projectDir, ".golem", "state"));

  // Usage-limit prediction freshness (read-only; snooze P2a). A stale reading
  // means the proxy has stopped seeing the rate-limit headers (the auto-park is
  // blind) — surfaced both as a field and, when stale, a warning.
  const nowMs = options.now?.() ?? Date.now();
  const limitState = await (options.readLimit ?? readLimitState)(projectDir).catch(() => null);
  const limits =
    limitState === null ? undefined : buildLimits(limitState, nowMs, settings.snooze.enforce);

  // §103: what the compression dial will ACTUALLY do on this upstream. The dial —
  // not the slider — is the input-side level the pipeline reads (Decision 52), and
  // it may be pinned away from the slider, so predict from the dial's effective
  // value. The provider override wins over the URL heuristic exactly as it does in
  // the pipeline; `undefined` means "use the heuristic" and must not be passed.
  const assumeCaching = upstreamAssumesCaching(upstream.provider);
  const effective = resolveEffectiveCompression({
    level: sliderLevelFromDial(compressionDial.effective, slider.level),
    upstreamBaseUrl: upstream.baseUrl,
    ...(assumeCaching !== undefined && { assumeCachingUpstream: assumeCaching }),
    headroomSidecar: settings.compression.headroom_sidecar,
    forceSemanticOnCaching: settings.compression.force_semantic_on_caching,
  });

  const config: Record<string, ConfigKeyStatus> = {};
  for (const [dotted, entry] of Object.entries(provenance)) {
    const [section, key] = dotted.split(".", 2) as [string, string];
    const sectionValues = (settings as unknown as Record<string, Record<string, unknown>>)[section];
    config[dotted] = {
      value: sectionValues?.[key],
      layer: entry.layer,
      ...(entry.source !== undefined && { source: entry.source }),
    };
  }

  return {
    version: options.version,
    project_dir: projectDir,
    initialized: {
      overall: init.initialized,
      claude_settings: init.claudeSettingsWired,
      mcp_registered: init.mcpRegistered,
      skills: init.skillsInstalled,
      golem_settings: init.golemSettingsPresent,
    },
    proxy: {
      port: settings.proxy.port,
      url: `http://localhost:${settings.proxy.port}`,
      reachable,
    },
    upstream: {
      provider: upstream.provider,
      account: upstream.accountId,
      base_url: upstream.baseUrl,
      default_model: upstream.model ?? null,
      ...(servedModel !== null
        ? { last_served_model: servedModel.model, last_served_at: servedModel.servedAtIso }
        : {}),
    },
    slider: sliderJson(slider),
    dials: { brevity: dialJson(brevityDial), compression: dialJson(compressionDial) },
    effective_compression: effectiveCompressionJson(effective),
    config,
    local_model: {
      reachable: localInfo.reachable,
      coder_enabled: settings.inference.local_coder_enabled,
      ...(localInfo.coderModel !== undefined ? { coder_model: localInfo.coderModel } : {}),
      base_url: settings.inference.ollama_base_url,
    },
    ...(cachedUpdate !== null
      ? {
          update: {
            available:
              cachedUpdate.latest !== null && semverGt(cachedUpdate.latest, options.version),
            current: options.version,
            latest: cachedUpdate.latest,
          },
        }
      : {}),
    ...(limits !== undefined ? { limits } : {}),
    warnings: [
      ...(cachedUpdate?.latest != null && semverGt(cachedUpdate.latest, options.version)
        ? [...updateWarnings(cachedUpdate.latest, slider.level), ...warnings]
        : slider.level === 0
          ? [...warnings, REDACTION_OFF_WARNING]
          : warnings),
      ...(limits?.stale ? [LIMIT_STALE_WARNING] : []),
    ],
  };
}

/**
 * Build the {@link StatusReport}["limits"] view from a persisted prediction.
 * `stale` uses the same {@link STALE_AFTER_MS} threshold the snooze auto-park
 * trigger uses, so `golem status` and the trigger agree on when the feed is cold.
 */
function buildLimits(
  pred: LimitPrediction,
  nowMs: number,
  enforced: boolean,
): StatusReport["limits"] {
  const observedMs = Date.parse(pred.observedAtIso);
  const ageMs = Number.isFinite(observedMs)
    ? Math.max(0, nowMs - observedMs)
    : Number.POSITIVE_INFINITY;
  return {
    five_hour_utilization: pred.fiveHour.utilization,
    ...(pred.sevenDay !== undefined ? { seven_day_utilization: pred.sevenDay.utilization } : {}),
    reset_at: pred.fiveHour.resetAtIso,
    observed_at: pred.observedAtIso,
    age_minutes: Number.isFinite(ageMs) ? Math.round(ageMs / 60_000) : -1,
    stale: ageMs > STALE_AFTER_MS,
    enforced,
  };
}

/** Warning shown when the rate-limit feed has gone cold (auto-park is blind). */
export const LIMIT_STALE_WARNING =
  "Usage-limit prediction is STALE — Golem hasn't seen fresh rate-limit headers " +
  "recently, so the snooze auto-park is BLIND. The active account/upstream may not " +
  "emit `anthropic-ratelimit-unified-*` headers (common after an account switch). " +
  "Watch Claude Code's own limit indicator and park manually if needed.";

/** Warning lines when a newer version is known (plus the level-0 redaction one). */
function updateWarnings(latest: string, sliderLevel: number): string[] {
  const w = [`A newer Golem is available (${latest}). Run \`golem update\`.`];
  if (sliderLevel === 0) w.push(REDACTION_OFF_WARNING);
  return w;
}

/**
 * One dial, rendered for the human `golem status`. Mirrors `describeDial` in
 * dials.ts but works off the JSON report (which is what the VS Code panel and
 * any script read), so the two surfaces cannot disagree.
 */
/**
 * One dial's line. `effectiveValue` (§103) overrides the displayed value when the
 * dial's setting is not what the pipeline will apply — the compression dial can
 * read "3" while the upstream gate makes it behave as 1, and showing the setting
 * alone is the misreport this exists to prevent.
 */
function renderDial(
  kind: string,
  dial: DialStatus,
  sliderLevel: number,
  effectiveValue?: string,
): string {
  const shown =
    effectiveValue !== undefined && effectiveValue !== dial.effective
      ? `${dial.effective}→${effectiveValue}`
      : dial.effective;
  if (!dial.pinned) return `${kind} ${shown} (auto — follows slider ${sliderLevel})`;
  return `${kind} ${shown} (${dial.layer === "default" ? "default" : "pinned"})`;
}

/** Shown whenever the slider is at level 0 (passthrough): redaction is disabled. */
export const REDACTION_OFF_WARNING =
  "Slider level 0 (passthrough) is a FULL BYPASS: redaction is OFF, so secrets/PII " +
  "reach the upstream unredacted. Use level 1 to keep redaction on.";

/** One-line rendering of the usage-limit prediction + freshness. */
export function renderLimits(limits: NonNullable<StatusReport["limits"]>): string {
  const pct = Math.round(limits.five_hour_utilization * 100);
  const park = limits.enforced ? "enforced" : "advisory";
  if (limits.stale) {
    const age = limits.age_minutes < 0 ? "unknown" : `${limits.age_minutes}m ago`;
    return `Limits: STALE (last reading ${age}, 5h ${pct}%) — auto-park blind; active account may not emit rate-limit headers · park ${park}`;
  }
  const reset = limits.reset_at !== null ? ` (resets ${limits.reset_at})` : "";
  return `Limits: 5h window ${pct}% used${reset} · observed ${limits.age_minutes}m ago · park ${park}`;
}

function dialJson(dial: DialInfo): DialStatus {
  return {
    setting: dial.setting,
    effective: dial.effective,
    pinned: dial.pinned,
    layer: dial.layer,
    ...(dial.source !== undefined && { source: dial.source }),
  };
}

/**
 * The compression dial's effective value as a {@link SliderLevel}. The dial is a
 * string (`"auto"` resolves to a numeral before it reaches here), so a
 * non-numeric or out-of-range value falls back to the slider's own level rather
 * than guessing — status must never invent a level.
 */
function sliderLevelFromDial(dialEffective: string, fallback: SliderLevel): SliderLevel {
  const n = Number(dialEffective);
  return n === 0 || n === 1 || n === 2 || n === 3 ? n : fallback;
}

function effectiveCompressionJson(
  eff: EffectiveCompression,
): StatusReport["effective_compression"] {
  return {
    nominal: eff.nominal,
    nominal_name: SLIDER_LEVEL_NAMES[eff.nominal],
    effective: eff.effective,
    effective_name: SLIDER_LEVEL_NAMES[eff.effective],
    degraded: eff.degraded,
    ...(eff.reason !== undefined && { reason: eff.reason }),
  };
}

function sliderJson(slider: SliderInfo): StatusReport["slider"] {
  return {
    level: slider.level,
    name: slider.name,
    layer: slider.layer,
    ...(slider.source !== undefined && { source: slider.source }),
  };
}

function checkbox(ok: boolean): string {
  return ok ? "[ok]" : "[--]";
}

/** Human-readable rendering (the default, non---json output). */
export function renderStatus(report: StatusReport): string {
  const lines: string[] = [];
  lines.push(`Golem ${report.version} — ${report.project_dir}`);
  lines.push("");

  const init = report.initialized;
  lines.push(`Project wiring ${init.overall ? "(initialized)" : "(run `golem init`)"}`);
  lines.push(`  ${checkbox(init.claude_settings)} .claude/settings.json -> proxy base URL`);
  lines.push(`  ${checkbox(init.mcp_registered)} .mcp.json -> golem MCP server`);
  lines.push(`  ${checkbox(init.skills)} /golem/* skills installed`);
  lines.push(`  ${checkbox(init.golem_settings)} .golem/settings.json present`);
  lines.push("");

  lines.push(
    `Proxy: ${report.proxy.url} — ${report.proxy.reachable ? "reachable" : "not running (start with `golem proxy`)"}`,
  );
  lines.push(`Upstream: ${renderUpstream(report.upstream)}`);
  const slider = report.slider;
  const ec = report.effective_compression;
  // §103: the LABEL carries the truth. A warning line under a headline that still
  // reads "aggressive" leaves the headline wrong — which is exactly what the first
  // pass at this got wrong.
  const effSuffix = ec.degraded ? ` → effectively ${ec.effective} (${ec.effective_name})` : "";
  lines.push(
    `Slider: level ${slider.level} (${slider.name})${effSuffix} — set by ${slider.layer}` +
      (slider.source !== undefined ? ` (${slider.source})` : ""),
  );
  // Decision 52: the slider is a preset, so name both dials and whether the
  // slider is driving them. A pinned dial must never look like a preset.
  lines.push(
    `Dials: ${renderDial("brevity", report.dials.brevity, slider.level)} · ${renderDial(
      "compression",
      report.dials.compression,
      slider.level,
      String(ec.effective),
    )}`,
  );
  // The headline already says the effective level; this line says WHY and what to
  // do about it, which does not fit in a label.
  if (ec.degraded) {
    lines.push(`  ⚠ level ${ec.nominal} (${ec.nominal_name}) is inert here: ${ec.reason ?? ""}`);
  }
  if (report.dials.brevity.effective !== "off") {
    lines.push(
      `  ⚠ brevity ${report.dials.brevity.effective} is active: replies are shortened ` +
        `(output tokens only; code/commands/errors stay verbatim). Check it pays: golem stats --brevity`,
    );
  }
  // Inference topology: a reachable local model makes Golem local+upstream —
  // available via the `coder` MCP tool at any level (Decision 30/31). Name the
  // concrete coder model when known. If the coder tool is disabled, show only
  // the upstream backend (the local model may still be used for rerank/local-answer).
  const coder = report.local_model.coder_model;
  const localCoderActive = report.local_model.coder_enabled && report.local_model.reachable;
  lines.push(
    localCoderActive
      ? `Inference: local + upstream${coder !== undefined ? ` · coder ${coder}` : ""}`
      : report.local_model.coder_enabled
        ? "Inference: upstream only"
        : "Inference: upstream only (local coder disabled)",
  );
  if (report.update !== undefined) {
    lines.push(
      report.update.available
        ? `Update: ${report.update.current} → ${report.update.latest} available (run \`golem update\`)`
        : `Update: up to date (${report.update.current})`,
    );
  }
  if (report.limits !== undefined) {
    lines.push(renderLimits(report.limits));
  }
  lines.push("");

  lines.push("Config (value — layer):");
  for (const [key, entry] of Object.entries(report.config)) {
    const value = JSON.stringify(entry.value);
    const source = entry.source !== undefined ? ` (${entry.source})` : "";
    lines.push(`  ${key} = ${value} — ${entry.layer}${source}`);
  }

  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of report.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

// Re-exported for the callers that have always imported them from here.
export { renderUpstream, upstreamLabel } from "./upstream-display.js";
