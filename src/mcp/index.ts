/**
 * WS-B: unified MCP server via @modelcontextprotocol/sdk (owned by agent-mcp).
 *
 * Frozen tool names (IMPLEMENTATION_PLAN §2.5): search, fetch,
 * ingest, expand, stats, level, coder (renamed from delegate, Decision 35),
 * golem_devices. Prompts: slider, index, search, stats, expand, bypass,
 * devices, coder (surface in Claude Code as /mcp__golem__<prompt>).
 *
 * B1 ships the P0 tools (expand, stats, level) and all
 * eight prompts, over stdio and streamable-HTTP transports. P1 tools arrive
 * with task B3 once WS-C/WS-D implementations exist.
 */

export type { GolemMcpServerDeps } from "./deps.js";
export type { InMemoryCompressionServiceOptions } from "./in-memory-compression.js";
export { ccrMarker, InMemoryCompressionService } from "./in-memory-compression.js";
export type { Grounding, HitAssemblyDeps } from "./search.js";
export type { GolemHttpServerHandle, ServeHttpOptions } from "./serve.js";
export { serveHttp, serveStdio } from "./serve.js";
export {
  boostWikiHits,
  createGolemMcpServer,
  createStandaloneDeps,
  gatherGrounding,
  graphFirstWikiHits,
  pageToHit,
} from "./server.js";
export { GOLEM_MCP_SERVER_NAME, GOLEM_MCP_SERVER_VERSION } from "./shared.js";
