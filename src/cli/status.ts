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
import { loadConfig, policyFromSettings } from "../config/index.js";
import type { OllamaBootstrapDeps } from "../inference/index.js";
import { effectiveStages } from "../interfaces/policy.js";
import { golemInitStatus } from "./init.js";
import { collectOllamaStatus } from "./ollama.js";
import { getSliderInfo, type SliderInfo } from "./slider.js";

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
  readonly slider: {
    readonly level: number;
    readonly name: string;
    readonly layer: string;
    readonly source?: string;
  };
  /** Dotted `section.key` -> effective value + provenance. */
  readonly config: Readonly<Record<string, ConfigKeyStatus>>;
  readonly local_first: {
    /** Slider level 5 + `local_only_opt_in` — Decision 25 Mode B is configured to run. */
    readonly intended: boolean;
    /** Only meaningful when `intended`: Ollama installed, reachable, and the tier's model pulled. */
    readonly ready: boolean;
    /** This tier's drafter model, present whenever `intended` (regardless of readiness). */
    readonly model?: string;
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
  /** Test injection (forwarded to collectOllamaStatus) — avoids real probes in tests. */
  readonly ollamaDeps?: OllamaBootstrapDeps;
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
  // Only probe Ollama when local-first is actually configured to run — the
  // capability + reachability probes are real OS/HTTP calls, not worth paying
  // on every poll at slider levels where Mode B can't fire anyway.
  const intended = effectiveStages(policyFromSettings(settings)).localOnlyAnswers;
  const [init, reachable, slider, ollama] = await Promise.all([
    golemInitStatus(projectDir, settings.proxy.port),
    probeProxy(settings.proxy.port, options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
    getSliderInfo(sliderOpts),
    intended
      ? collectOllamaStatus({
          projectDir,
          ...(options.userDir !== undefined && { userDir: options.userDir }),
          ...(options.ollamaDeps !== undefined && { deps: options.ollamaDeps }),
        })
      : Promise.resolve(undefined),
  ]);

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
    slider: sliderJson(slider),
    config,
    local_first: {
      intended,
      ready: (ollama?.reachable ?? false) && (ollama?.modelPulled ?? false),
      ...(ollama !== undefined && { model: ollama.targetModel }),
    },
    warnings,
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
  const slider = report.slider;
  lines.push(
    `Slider: level ${slider.level} (${slider.name}) — set by ${slider.layer}` +
      (slider.source !== undefined ? ` (${slider.source})` : ""),
  );
  lines.push("");

  const localFirst = report.local_first;
  if (localFirst.intended) {
    lines.push(
      `Local-first: intended (slider 5 + local_only_opt_in) — ` +
        (localFirst.ready
          ? `ready (${localFirst.model})`
          : `not ready (run \`golem ollama setup\`${localFirst.model !== undefined ? ` for ${localFirst.model}` : ""})`),
    );
    lines.push("");
  }

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
