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
import type { InferenceService } from "../interfaces/inference.js";
import type { KnowledgeBase } from "../interfaces/knowledge.js";
import type { VectorDriver } from "./driver.js";
import { inferenceEmbedFn } from "./embedder.js";
import { FileVectorDriver } from "./file-driver.js";
import { hashingEmbedFn } from "./hashing-embedder.js";
import {
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
  windowChunks,
} from "./chunker.js";
export type {
  DistillDraft,
  DistillInput,
  NoteDistillInput,
  NoteDraft,
  SynthesisDraft,
  SynthesisInput,
} from "./distill.js";
export { DistillParseError, distillNote, distillPage, synthesizeWeekly } from "./distill.js";
export type { DraftFile } from "./distill-store.js";
export {
  distillDir,
  findDraftByNoteTs,
  findDraftByUrl,
  listDraftFiles,
  readDraftFile,
  writeDraftFile,
  writeNoteDraftFile,
  writeSynthesisDraftFile,
} from "./distill-store.js";
export type { StoredChunk, VectorDriver, VectorMatch } from "./driver.js";
export {
  assertEmbedderSpaceMatch,
  cosineSimilarity,
  EmbedderMismatchError,
  InMemoryVectorDriver,
  KNOWLEDGE_SCHEMA_VERSION,
} from "./driver.js";
export { inferenceEmbedFn } from "./embedder.js";
export { extractHtmlText, extractPdfText } from "./extractors.js";
export {
  canonicalProjectId,
  collectionDir,
  FileVectorDriver,
  readCollectionDim,
} from "./file-driver.js";
export type { FileChangeBatch, FileWatcher, FileWatcherOptions } from "./file-watcher.js";
export { watchPath } from "./file-watcher.js";
export { DEFAULT_HASH_DIM, hashEmbed, hashingEmbedFn, tokenize } from "./hashing-embedder.js";
export type { FileState, IngestPlan, PreparedChunk } from "./ingest.js";
export {
  chunkFilesRelativeTo,
  chunkIdFor,
  MAX_FILE_BYTES,
  planIngest,
  SKIP_DIRS,
  scanFiles,
  toPosix,
} from "./ingest.js";
export type { EmbedFn, IncrementalIngest, KnowledgeBaseOptions } from "./knowledge-base.js";
export {
  asFederatedSearch,
  GolemKnowledgeBase,
  isMemoryChunkId,
  NotImplementedYetError,
  supportsIncremental,
} from "./knowledge-base.js";
export type { RawPage, RawPageHeaders } from "./raw-fetch.js";
export { fetchRawPage } from "./raw-fetch.js";
export type {
  RankedFile,
  RepoFile,
  RepoMapOptions,
  RepoMapReady,
  RepoMapResult,
  RepoMapUnavailable,
} from "./repo-map.js";
export {
  buildGraph,
  buildRepoMap,
  clearRepoMapCache,
  DEFAULT_MAP_BUDGET_TOKENS,
  MAX_MAP_BUDGET_TOKENS,
  rankFiles,
  renderFileSkeleton,
  renderRepoMap,
  scanRepoFiles,
} from "./repo-map.js";
export type {
  BenchArm,
  BenchOptions,
  BenchVerdict,
  RepoMapBenchReport,
  RetrievalOutcome,
  RetrievalRun,
} from "./repo-map-bench.js";
export { benchRepoMap, renderRepoMapBench, runRetrievalArm } from "./repo-map-bench.js";
export type { RetrievalCase } from "./repo-map-cases.js";
export { RETRIEVAL_CASES } from "./repo-map-cases.js";
export { rerankHits } from "./rerank.js";
export type { FileFacts, SymbolDef, SymbolKind } from "./tree-sitter-chunker.js";
export {
  chunkCodeSyntaxAware,
  extractFileFacts,
  hasParseError,
  isSymbolExtractable,
} from "./tree-sitter-chunker.js";
export type { WebCacheEntry, WebCacheMeta } from "./web-cache.js";
export { isFresh, WebCache, webCacheDir, webCacheKey } from "./web-cache.js";

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
  /**
   * WS-D inference service — its `embed` becomes the KB embedder (C3). Ignored
   * if an explicit `embed` is provided (tests). Without either, ingest/search
   * raise NotImplementedYetError.
   */
  readonly inference?: InferenceService;
  /** R3.3: try `web-tree-sitter` syntax-aware chunking for TS/JS before the heuristic. */
  readonly syntaxAwareChunking?: boolean;
}

/**
 * Build a KnowledgeBase, selecting the vector driver and the embedder:
 *  - driver: an injected `driver` wins; else `vectorDbUrl` → Qdrant (stub);
 *    else the embedded default (in-memory at C1 until the native engine, §26);
 *  - embedder: explicit `embed` wins; else `inference` (WS-D bge-m3, SEMANTIC);
 *    else the pure-TS hashing embedder (LEXICAL) so the KB works with zero setup.
 */
export function openKnowledgeBase(options: OpenKnowledgeBaseOptions): KnowledgeBase {
  const driver = selectDriver(options);
  const embed =
    options.embed ?? (options.inference ? inferenceEmbedFn(options.inference) : hashingEmbedFn());
  const kbOptions: KnowledgeBaseOptions = {
    embed,
    syntaxAwareChunking: options.syntaxAwareChunking ?? false,
    ...(options.memorySearch !== undefined ? { memorySearch: options.memorySearch } : {}),
  };
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
  // Embedded default: the durable, pure-TS file driver under knowledgeDir — an
  // index survives across sessions with no native dependency (§26 refinement:
  // brute-force at dev-KB scale; LanceDB stays the OPTIONAL scale upgrade behind
  // this same seam). InMemoryVectorDriver remains for injected/test use.
  return new FileVectorDriver(knowledgeDir(options.projectDir));
}
