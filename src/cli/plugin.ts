/**
 * `golem plugin` — what third-party code is running inside Golem, and from where
 * (R8.11 / ADR-0005).
 *
 * Deliberately **read-only, and deliberately blunt**. There is no `install`
 * verb: installing third-party code is `npm`'s job, and offering the verb here
 * would imply a vetting Golem does not perform. What this surface owes the user
 * is the truth — which plugins loaded, which copy of each, what each registered,
 * what failed, and the fact that none of it is sandboxed.
 *
 * The sibling surface is `golem pkg`, which manages tools Golem *spawns*. That
 * one can consent-gate an install because a subprocess is a real boundary. This
 * one cannot, which is exactly why they were kept separate (Decision 53(g)).
 */

import { loadConfig } from "../config/index.js";
import { loadPlugins } from "../plugins/index.js";
import type { LoadedPlugins } from "../plugins/types.js";

export interface PluginReport {
  readonly projectDir: string;
  readonly enabled: boolean;
  /** Specifiers from `plugins.load`, verbatim. */
  readonly configured: readonly string[];
  readonly loaded: LoadedPlugins;
}

/**
 * Actually load the configured plugins and report what happened.
 *
 * This runs the plugins' `setup()`, because there is no honest way to report
 * what a plugin registers without asking it — a manifest would be a claim, and
 * this surface exists to report facts. It is the same code path the proxy runs,
 * so what you see here is what the proxy got.
 */
export async function collectPlugins(
  projectDir: string,
  golemVersion: string,
): Promise<PluginReport> {
  const { settings } = await loadConfig({ projectDir });
  const loaded = await loadPlugins({
    specifiers: settings.plugins.load,
    enabled: settings.plugins.enabled,
    projectDir,
    golemVersion,
  });
  return {
    projectDir,
    enabled: settings.plugins.enabled,
    configured: settings.plugins.load,
    loaded,
  };
}

const NO_SANDBOX_NOTICE =
  "A plugin runs INSIDE Golem's process, which means inside the redaction path. " +
  "There is no sandbox: loading one is exactly as dangerous as importing a " +
  "dependency you installed yourself. Golem constrains what a plugin is asked " +
  "to do, not what it can do — see ADR-0005.";

/** Greedy word wrap, returning unprefixed lines. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line = `${line} ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line !== "") out.push(line);
  return out;
}

export function renderPlugins(report: PluginReport, verbose = false): string {
  const out: string[] = ["Golem plugins — third-party code running inside this process", ""];

  if (!report.enabled) {
    out.push("plugins.enabled = false — nothing was loaded, whatever the list says.");
    if (report.configured.length > 0) {
      out.push(`${report.configured.length} specifier(s) configured and skipped:`);
      for (const spec of report.configured) out.push(`  · ${spec}`);
    }
    return `${out.join("\n")}\n`;
  }

  if (report.configured.length === 0) {
    out.push("None configured. `plugins.load` is empty, which is the default.");
    out.push("");
    out.push(
      "Nothing is discovered: Golem never scans node_modules, follows no naming convention,",
    );
    out.push("and downloads nothing. A plugin loads only because you named it.");
    return `${out.join("\n")}\n`;
  }

  for (const plugin of report.loaded.plugins) {
    const version = plugin.version === null ? "" : ` v${plugin.version}`;
    out.push(`  [loaded]  ${plugin.name}${version}`);
    out.push(`            from ${plugin.specifier}`);
    out.push(`            → ${plugin.resolved}`);
    const seams = [
      plugin.seams["redaction-rule"] > 0
        ? `${plugin.seams["redaction-rule"]} redaction rule(s)`
        : null,
      plugin.seams["pipeline-stage"] > 0
        ? `${plugin.seams["pipeline-stage"]} pipeline stage(s)`
        : null,
      plugin.seams["mcp-tool"] > 0 ? `${plugin.seams["mcp-tool"]} MCP tool(s)` : null,
    ].filter((s): s is string => s !== null);
    out.push(`            registered: ${seams.length === 0 ? "nothing" : seams.join(", ")}`);
    if (plugin.description !== null) {
      for (const line of wrap(plugin.description, 62)) out.push(`            ${line}`);
    }
  }

  const unloaded = report.configured.filter(
    (spec) => !report.loaded.plugins.some((p) => p.specifier === spec),
  );
  for (const spec of unloaded) out.push(`  [failed]  ${spec}`);

  if (report.loaded.problems.length > 0) {
    out.push("");
    out.push("Problems (each one is a no-op, never an error path):");
    for (const problem of report.loaded.problems) {
      const lines = wrap(`${problem.subject}: ${problem.reason}`, 74);
      for (const [i, line] of lines.entries()) out.push(`  ${i === 0 ? "·" : " "} ${line}`);
    }
  }

  if (verbose) {
    out.push("");
    out.push("Redaction rules contributed (appended AFTER every built-in, never before):");
    if (report.loaded.redactionRules.length === 0) out.push("  (none)");
    for (const rule of report.loaded.redactionRules) {
      out.push(`  · [REDACTED:${rule.id}:n]`);
      for (const line of wrap(rule.description, 70)) out.push(`      ${line}`);
    }
    out.push("");
    out.push("Pipeline stages (run after redaction; redaction re-runs over their output):");
    if (report.loaded.stages.length === 0) out.push("  (none)");
    for (const stage of report.loaded.stages) out.push(`  · ${stage.name} — ${stage.description}`);
    out.push("");
    out.push("MCP tools (a name colliding with a built-in is rejected at load):");
    if (report.loaded.mcpTools.length === 0) out.push("  (none)");
    for (const tool of report.loaded.mcpTools) out.push(`  · ${tool.name} — ${tool.title}`);
  }

  out.push("");
  out.push(
    `${report.loaded.plugins.length} loaded · ${report.loaded.problems.length} problem(s) · ` +
      `${report.loaded.redactionRules.length} redaction rule(s) · ` +
      `${report.loaded.stages.length} stage(s) · ${report.loaded.mcpTools.length} tool(s)`,
  );
  out.push("");
  for (const line of wrap(NO_SANDBOX_NOTICE, 78)) out.push(line);
  return `${out.join("\n")}\n`;
}
