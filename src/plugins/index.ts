/**
 * `src/plugins/` — the in-process plugin surface (R8.11, spec Decision 53(g)).
 *
 * A plugin runs **inside** Golem; a `pkg` runs beside it. That difference is the
 * whole reason the two surfaces are separate, and the threat model for this one
 * is `docs/decisions/ADR-0005-plugin-seams-and-the-redaction-path.md` — read it
 * before touching anything here. Its headline: **there is no sandbox.**
 */

export { type InitPluginsOptions, initPlugins } from "./init.js";
export { BUILTIN_MCP_TOOL_NAMES, type LoadPluginsOptions, loadPlugins } from "./loader.js";
export type {
  GolemPlugin,
  GolemPluginApi,
  LoadedPlugin,
  LoadedPlugins,
  PluginMcpTool,
  PluginPipelineStage,
  PluginProblem,
  PluginRedactionRule,
  PluginSeam,
  PluginStageInput,
} from "./types.js";
