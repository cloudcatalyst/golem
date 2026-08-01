/**
 * R8.11 — `golem plugin list` (ADR-0004 threat 10: a plugin cannot load silently).
 *
 * Reports every declared plugin whether or not it loaded, because the rows that
 * matter most are the ones that contributed nothing: a typo'd specifier, a
 * package the user never installed, a pin that no longer matches, a rule the
 * compiler rejected. Each of those is a no-op by design, and a no-op nobody can
 * see is indistinguishable from a feature that does not work.
 *
 * Pure over its input — the caller loads, this renders — so every state below is
 * reachable in a test without installing anything.
 */

import type { PluginLoadFailure } from "../interfaces/plugin.js";
import type { PluginRuleTiming } from "../pipeline/plugin-rules.js";
import type { LoadedPlugin, LoadResult } from "../plugins/index.js";

/** One-line explanation per failure, in the reader's terms rather than the loader's. */
const FAILURE_TEXT: Readonly<Record<PluginLoadFailure, string>> = {
  unresolved: "not installed",
  "import-failed": "failed to import",
  "invalid-export": "not a Golem plugin",
  "pin-mismatch": "version does not match the pin",
  "no-seams-enabled": "no seams granted",
};

export interface RenderPluginOptions {
  /** Measured per-rule cost, when the caller has it (the proxy does; the CLI does not). */
  readonly timings?: ReadonlyMap<string, PluginRuleTiming>;
  readonly verbose?: boolean;
}

function contributions(plugin: LoadedPlugin): string {
  const parts: string[] = [];
  if (plugin.redactionRules.length > 0)
    parts.push(`${plugin.redactionRules.length} redaction rule(s)`);
  if (plugin.stage !== undefined) parts.push(`stage "${plugin.stage.name}"`);
  if (plugin.tools.length > 0) parts.push(`${plugin.tools.length} tool(s)`);
  return parts.length === 0 ? "nothing" : parts.join(", ");
}

export function renderPlugins(result: LoadResult, options: RenderPluginOptions = {}): string {
  if (result.plugins.length === 0) {
    return (
      "No plugins declared.\n\n" +
      "Golem loads plugins from YOUR install — it never downloads or installs one\n" +
      "(ADR-0004). Declare one under `plugins.entries` in settings.json:\n\n" +
      '  { "id": "acme", "specifier": "@acme/golem-plugin", "pin": "1.2.0",\n' +
      '    "seams": ["redaction"] }\n\n' +
      "`seams` is the consent — listing a package grants nothing until you name the\n" +
      "seams it may use. `redaction` accepts patterns only, never code; `stage` and\n" +
      "`tool` run unsandboxed in Golem's process.\n"
    );
  }

  const lines: string[] = ["Golem plugins (resolved from your own install — never fetched):"];
  for (const plugin of result.plugins) {
    const seams = plugin.seams.length === 0 ? "none" : plugin.seams.join(", ");
    if (plugin.failure !== undefined) {
      lines.push(`  ✗ ${plugin.id}  ${plugin.specifier}`);
      lines.push(`        ${FAILURE_TEXT[plugin.failure]} — contributing nothing`);
      if (plugin.detail !== undefined) lines.push(`        ${plugin.detail}`);
      continue;
    }
    const version = plugin.version !== undefined ? ` v${plugin.version}` : "";
    const pin = plugin.pin !== undefined ? ` (pinned ${plugin.pin})` : " (unpinned)";
    lines.push(`  ✓ ${plugin.id}  ${plugin.name ?? "?"}${version}${pin}`);
    lines.push(`        seams granted: ${seams} — provides ${contributions(plugin)}`);
    if (plugin.detail !== undefined) lines.push(`        note: ${plugin.detail}`);
    if (options.verbose === true && plugin.resolvedPath !== undefined) {
      lines.push(`        from: ${plugin.resolvedPath}`);
    }
    for (const rule of plugin.redactionRules) {
      const timing = options.timings?.get(rule.id);
      const cost =
        timing === undefined
          ? ""
          : ` — ${timing.applications} application(s), max ${timing.maxMs.toFixed(2)}ms`;
      lines.push(`        rule ${rule.id}: ${rule.description}${cost}`);
    }
    for (const rejected of plugin.rejectedRules) {
      lines.push(`        rule ${rejected.id} REJECTED: ${rejected.reason}`);
    }
    for (const tool of plugin.tools) {
      lines.push(`        tool ${plugin.name}__${tool.name}: ${tool.title}`);
    }
  }

  const toolCount = result.plugins.reduce((n, p) => n + p.tools.length, 0);
  if (toolCount > 0) {
    lines.push("");
    lines.push(
      `  ${toolCount} plugin tool definition(s) are sent with EVERY request, called or not (§88/§100).`,
    );
  }
  const stageCount = result.plugins.filter((p) => p.stage !== undefined).length;
  if (stageCount > 0) {
    lines.push(
      `  ${stageCount} plugin stage(s) run only at slider ≥2 on a NON-caching upstream — never on Anthropic.`,
    );
  }
  return `${lines.join("\n")}\n`;
}
