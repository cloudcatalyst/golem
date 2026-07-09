/**
 * WS-E — `golem mcp serve`'s CompressionService wiring.
 *
 * Split out from main.ts so it's importable by tests without triggering that
 * file's unconditional `program.parseAsync(process.argv)`.
 */

import { NativeLosslessCompression } from "../compression/index.js";
import type { CompressionService } from "../interfaces/compression.js";
import { openTelemetryStore, telemetryStatsSource } from "../telemetry/index.js";
import { liveStatsSource, type StatsSource } from "./stats.js";

/**
 * Pick the stats source for read commands: durable telemetry (A4) once it has
 * recorded at least one request, else the in-memory live source (E3). This lets
 * `golem stats` show cross-session history when the proxy has run, and still
 * work before any telemetry exists.
 */
export async function statsSourceForCli(projectDir: string): Promise<StatsSource> {
  const store = openTelemetryStore(projectDir);
  try {
    const agg = await store.aggregate();
    if (agg.requests > 0) return telemetryStatsSource(store);
  } catch {
    // fall through to live
  }
  return liveStatsSource(projectDir);
}

/**
 * `stats`'s CompressionService, wired so `stats()` prefers durable
 * telemetry over this process's own live counters (same preference as
 * `statsSourceForCli`). The MCP server never calls `compress()` itself — the
 * proxy does, in a separate process — so the live NativeLosslessCompression
 * instance's in-memory accounts stay empty even while the proxy is actively
 * serving requests. `compress()`/`retrieve()` still delegate to the live
 * instance: it owns the real CCR store `expand` reads from.
 */
export function mcpCompressionService(projectDir: string): CompressionService {
  const live = NativeLosslessCompression.forProjectDir(projectDir);
  return {
    compress: (messages, policy, projectId) => live.compress(messages, policy, projectId),
    retrieve: (ref) => live.retrieve(ref),
    stats: async (projectId) => (await statsSourceForCli(projectDir)).stats(projectId),
  };
}
