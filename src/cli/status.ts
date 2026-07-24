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
import { loadConfig } from "../config/index.js";
import { friendlyModelLabel, resolveUpstreamDisplay } from "../providers/index.js";
import { readServedModel } from "../proxy/index.js";
import { readCachedUpdateCheck, semverGt } from "../update/index.js";
import { golemInitStatus } from "./init.js";
import { type LocalModelInfo, probeAndCacheLocalModelInfo } from "./local-model.js";
import { getSliderInfo, type SliderInfo } from "./slider.js";
import { upstreamLabel } from "./statusline.js";

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
    /** Last model the proxy actually served (from served-model.json), if any. */
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
  /** Dotted `section.key` -> effective value + provenance. */
  readonly config: Readonly<Record<string, ConfigKeyStatus>>;
  /**
   * Whether a local model (Ollama) is reachable. When true, Golem is a
   * local+upstream hybrid — the local model is available via the `coder` MCP
   * tool at any slider level (Decision 30/31) — and `coder_model` names the
   * concrete model that role runs at this machine's hardware tier.
   */
  readonly local_model: {
    readonly reachable: boolean;
    /** The `coder`/`drafter` model (e.g. `qwen2.5-coder:7b`) when reachable. */
    readonly coder_model?: string;
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
  const localProbe = options.localProbe ?? probeAndCacheLocalModelInfo;
  const [init, reachable, slider, localInfo, servedModel] = await Promise.all([
    golemInitStatus(projectDir, settings.proxy.port),
    probeProxy(settings.proxy.port, options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
    getSliderInfo(sliderOpts),
    localProbe(projectDir, settings.inference.ollama_base_url).catch(
      (): LocalModelInfo => ({ reachable: false }),
    ),
    readServedModel(projectDir).catch(() => null),
  ]);

  // R6.2 display: the ACTIVE account/provider/model the proxy fronts (not just
  // the top-level base URL). No network, no secret — see resolveUpstreamDisplay.
  const upstream = resolveUpstreamDisplay(settings.proxy);

  // Update status from the cached check only (no network — never hang status).
  // Recompute "available" against the version we're actually running.
  const cachedUpdate = await readCachedUpdateCheck(path.join(projectDir, ".golem", "state"));

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
    config,
    local_model: {
      reachable: localInfo.reachable,
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
    warnings:
      cachedUpdate?.latest != null && semverGt(cachedUpdate.latest, options.version)
        ? [...updateWarnings(cachedUpdate.latest, slider.level), ...warnings]
        : slider.level === 0
          ? [...warnings, REDACTION_OFF_WARNING]
          : warnings,
  };
}

/** Warning lines when a newer version is known (plus the level-0 redaction one). */
function updateWarnings(latest: string, sliderLevel: number): string[] {
  const w = [`A newer Golem is available (${latest}). Run \`golem update\`.`];
  if (sliderLevel === 0) w.push(REDACTION_OFF_WARNING);
  return w;
}

/** Shown whenever the slider is at level 0 (passthrough): redaction is disabled. */
export const REDACTION_OFF_WARNING =
  "Slider level 0 (passthrough) is a FULL BYPASS: redaction is OFF, so secrets/PII " +
  "reach the upstream unredacted. Use level 1 to keep redaction on.";

/**
 * Human-readable upstream line, e.g.
 *   `kimi (openai) · api.moonshot.ai · model kimi-k3`
 * or, when the proxy has served a model that differs from the configured one:
 *   `kimi (openai) · api.moonshot.ai · default model kimi-k3 · last served <m>`
 * When no account is active, the leading `<account> ` is dropped.
 */
export function renderUpstream(upstream: StatusReport["upstream"]): string {
  const host = upstreamLabel(upstream.base_url);
  const who =
    upstream.account !== null
      ? `${upstream.account} (${upstream.provider})`
      : `${upstream.provider}`;
  const parts = [who];
  // Skip the host when it's redundant with what `who` already conveys — e.g. an
  // `anthropic` provider whose base URL also labels as `anthropic`.
  if (host !== upstream.provider && host !== upstream.account) parts.push(host);
  const dflt = upstream.default_model;
  const served = upstream.last_served_model ?? null;
  if (dflt !== null && served !== null && friendlyModelLabel(served) !== dflt && served !== dflt) {
    // A configured default exists AND the proxy served something else — show both
    // so the divergence is visible (e.g. a translating upstream mid-switch).
    parts.push(`default model ${dflt}`);
    parts.push(`last served ${friendlyModelLabel(served)}`);
  } else if (served !== null) {
    // No configured default (byte-faithful Anthropic), or it matches: the served
    // model IS the live model — show it as the current model.
    parts.push(`model ${friendlyModelLabel(served)}`);
  } else if (dflt !== null) {
    parts.push(`model ${dflt}`);
  }
  return parts.join(" · ");
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
  lines.push(
    `Slider: level ${slider.level} (${slider.name}) — set by ${slider.layer}` +
      (slider.source !== undefined ? ` (${slider.source})` : ""),
  );
  // Inference topology: a reachable local model makes Golem local+upstream —
  // available via the `coder` MCP tool at any level (Decision 30/31). Name the
  // concrete coder model when known.
  const coder = report.local_model.coder_model;
  lines.push(
    report.local_model.reachable
      ? `Inference: local + upstream${coder !== undefined ? ` · coder ${coder}` : ""}`
      : "Inference: upstream only",
  );
  if (report.update !== undefined) {
    lines.push(
      report.update.available
        ? `Update: ${report.update.current} → ${report.update.latest} available (run \`golem update\`)`
        : `Update: up to date (${report.update.current})`,
    );
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
