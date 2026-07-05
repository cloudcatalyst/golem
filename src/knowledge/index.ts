/**
 * WS-C — vector knowledge base. C1 delivers the store-agnostic scaffold: a
 * VectorDriver seam, an in-memory driver (functional, non-durable), the
 * GolemKnowledgeBase read path, and driver selection. Ingestion (C2),
 * embedding + rerank (C3), and MEMORY-scope federation (C4/sidecar) follow.
 *
 * Native embedded vector engines (LanceDB / sqlite-vec) are OPTIONAL deps loaded
 * lazily behind the driver seam so the default `npx golem-run` install stays
 * pure-TS (CLAUDE.md; decision memo in verification-notes §26).
 */

import path from "node:path";
import type { KnowledgeBase } from "../interfaces/knowledge.js";
import { InMemoryVectorDriver, type VectorDriver } from "./driver.js";
import {
  type EmbedFn,
  GolemKnowledgeBase,
  type KnowledgeBaseOptions,
  NotImplementedYetError,
} from "./knowledge-base.js";

export type { RawChunk } from "./chunker.js";
export {
  chunkCode,
  chunkFile,
  chunkMarkdown,
  chunkText,
  isChunkableExtension,
  MAX_CHUNK_CHARS,
} from "./chunker.js";
export type { StoredChunk, VectorDriver, VectorMatch } from "./driver.js";
export { cosineSimilarity, InMemoryVectorDriver, KNOWLEDGE_SCHEMA_VERSION } from "./driver.js";
export type { IngestPlan, PreparedChunk } from "./ingest.js";
export { chunkIdFor, MAX_FILE_BYTES, planIngest } from "./ingest.js";
export type { EmbedFn, KnowledgeBaseOptions } from "./knowledge-base.js";
export { asFederatedSearch, GolemKnowledgeBase, NotImplementedYetError } from "./knowledge-base.js";

/** Where a project's embedded vector store lives on disk. */
export function knowledgeDir(projectDir: string): string {
  return path.join(projectDir, ".golem", "knowledge");
}

export interface OpenKnowledgeBaseOptions extends KnowledgeBaseOptions {
  readonly projectDir: string;
  /** Qdrant server URL (spec Decision 12). When set, uses the server driver. */
  readonly vectorDbUrl?: string;
  /** Inject a driver directly (tests, or a future native driver). */
  readonly driver?: VectorDriver;
}

/**
 * Build a KnowledgeBase, selecting the vector driver:
 *  - an injected `driver` (tests / native driver) wins;
 *  - a `vectorDbUrl` selects the Qdrant-server driver (stubbed in C1);
 *  - otherwise the embedded driver. C1's embedded default is the in-memory
 *    driver (non-durable) until the chosen native engine (§26) is wired; the
 *    lazy-load + graceful-degrade path for the optional native dep lands with
 *    that engine.
 */
export function openKnowledgeBase(options: OpenKnowledgeBaseOptions): KnowledgeBase {
  const driver = selectDriver(options);
  const kbOptions: KnowledgeBaseOptions = {};
  if (options.embed !== undefined) (kbOptions as { embed?: EmbedFn }).embed = options.embed;
  return new GolemKnowledgeBase(driver, kbOptions);
}

function selectDriver(options: OpenKnowledgeBaseOptions): VectorDriver {
  if (options.driver !== undefined) return options.driver;
  if (options.vectorDbUrl !== undefined && options.vectorDbUrl !== "") {
    throw new NotImplementedYetError(
      `Qdrant server driver (vector_db_url=${options.vectorDbUrl})`,
      "C1-followup",
    );
  }
  // Embedded default. C1: in-memory (non-durable). The native embedded driver
  // (§26) replaces this line and reads/writes under knowledgeDir(projectDir).
  return new InMemoryVectorDriver();
}
