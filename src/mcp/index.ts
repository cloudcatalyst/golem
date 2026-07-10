/**
 * WS-B: unified MCP server via @modelcontextprotocol/sdk (owned by agent-mcp).
 *
 * Frozen tool names (IMPLEMENTATION_PLAN §2.5): search, fetch,
 * ingest, expand, stats, level, delegate,
 * golem_devices. Prompts: slider, index, search, stats, expand, bypass,
 * devices, delegate (surface in Claude Code as /mcp__golem__<prompt>).
 *
 * B1 ships the P0 tools (expand, stats, level) and all
 * eight prompts, over stdio and streamable-HTTP transports. P1 tools arrive
 * with task B3 once WS-C/WS-D implementations exist.
 */

export type { GolemHttpServerHandle, ServeHttpOptions } from "./serve.js";
export { serveHttp, serveStdio } from "./serve.js";
export type { GolemMcpServerDeps } from "./server.js";
export {
  boostWikiHits,
  createGolemMcpServer,
  createStandaloneDeps,
  GOLEM_MCP_SERVER_NAME,
  GOLEM_MCP_SERVER_VERSION,
} from "./server.js";
export type { SliderStore } from "./slider-store.js";
export {
  DEFAULT_SLIDER_LEVEL,
  defaultGolemSettingsPath,
  InMemorySliderStore,
  JsonFileSliderStore,
  LEGACY_SLIDER_LEVEL_KEY,
  SLIDER_LEVEL_SETTINGS_KEY,
} from "./slider-store.js";
export type { InMemoryCompressionServiceOptions } from "./stub-compression.js";
export { ccrMarker, InMemoryCompressionService } from "./stub-compression.js";
