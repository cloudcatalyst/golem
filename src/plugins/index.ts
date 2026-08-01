/**
 * R8.11 — the plugin surface (ADR-0004). Barrel for the loader, the seam-A
 * compiler and the quarantine adapters.
 *
 * The three seams are wired in three different places, deliberately:
 *   - seam A → `installPluginRedactionRules` (`src/pipeline/plugin-rules.ts`)
 *   - seam B → `GolemPipelineOptions.pluginStages` (`src/pipeline/pipeline.ts`)
 *   - seam C → `GolemMcpServerDeps.pluginTools` (`src/mcp/server.ts`)
 *
 * {@link activatePlugins} is the one call a host makes to do all three.
 */

import { installPluginRedactionRules } from "../pipeline/plugin-rules.js";
import { collectRedactionRules, type LoadResult, loadPlugins, type PluginEntry } from "./load.js";

export type { LoadedPlugin, LoadResult, PluginEntry } from "./load.js";
export { collectRedactionRules, loadPlugin, loadPlugins } from "./load.js";
export { pluginLog, runStageQuarantined, runToolQuarantined } from "./quarantine.js";
export type { CompiledRules, RejectedRule } from "./redaction-rules.js";
export {
  compileRedactionRules,
  lintPattern,
  MAX_PATTERN_CHARS,
  probeDeterminism,
} from "./redaction-rules.js";

/** Seam B, ready to hand to `createGolemPipeline`. */
export interface ActivePluginStages {
  readonly pluginName: string;
  readonly stage: NonNullable<import("../interfaces/plugin.js").PluginStage>;
}

/**
 * Load every declared plugin and install seam A, returning the seam-B stages
 * and seam-C tools for the caller to pass on.
 *
 * Called once at startup, before the proxy accepts a request — seam A's
 * installed list must be final before any redaction happens, or two requests in
 * the same process could redact the same text differently and break prefix
 * stability (verification-notes §14).
 */
export async function activatePlugins(
  projectDir: string,
  entries: readonly PluginEntry[],
): Promise<{
  readonly result: LoadResult;
  readonly stages: readonly ActivePluginStages[];
  readonly tools: readonly {
    readonly pluginName: string;
    readonly tool: import("../interfaces/plugin.js").PluginTool;
  }[];
}> {
  const result = await loadPlugins(projectDir, entries);
  installPluginRedactionRules(collectRedactionRules(result));

  const stages: ActivePluginStages[] = [];
  const tools: { pluginName: string; tool: import("../interfaces/plugin.js").PluginTool }[] = [];
  for (const plugin of result.plugins) {
    const pluginName = plugin.name ?? plugin.id;
    if (plugin.stage !== undefined) {
      stages.push({ pluginName, stage: plugin.stage });
    }
    for (const tool of plugin.tools) {
      tools.push({ pluginName, tool });
    }
  }
  return { result, stages, tools };
}
