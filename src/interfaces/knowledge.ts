/**
 * KnowledgeBase + FederatedSearch — FROZEN CONTRACT (IMPLEMENTATION_PLAN §2.3).
 *
 * Implemented by `src/knowledge/` (WS-C) on an embedded TS-native vector store
 * (LanceDB candidate, spec Decision 17; Qdrant server mode via config URL).
 * One collection/table per project. MEMORY scope delegates to Headroom's
 * conversational memory, which is Python-only and therefore only available when
 * the optional sidecar is present (spec Decisions 13 + 18) — without it,
 * searches degrade gracefully to KNOWLEDGE-only.
 */

/** Which stores a federated search covers. */
export type Scope = "knowledge" | "memory";

/** Default scopes for search(); immutable on purpose. */
export const DEFAULT_SCOPES: ReadonlySet<Scope> = Object.freeze(
  new Set<Scope>(["knowledge", "memory"]),
);

/** One indexed unit (code function/class, doc section, or memory fact). */
export interface Chunk {
  readonly chunkId: string;
  readonly projectId: string;
  readonly text: string;
  readonly sourcePath?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly metadata: Readonly<Record<string, string>>;
}

/** One reranked search result. */
export interface Hit {
  readonly chunk: Chunk;
  readonly score: number;
  readonly scope: Scope;
}

/** Outcome of one ingest() call. */
export interface IngestReport {
  readonly path: string;
  readonly projectId: string;
  readonly filesSeen: number;
  readonly chunksIndexed: number;
  readonly filesSkipped: number;
  readonly watching: boolean;
}

/** Thrown by getChunk() for an unknown chunk id. */
export class UnknownChunkError extends Error {
  constructor(chunkId: string) {
    super(`unknown chunk: ${chunkId}`);
    this.name = "UnknownChunkError";
  }
}

/** The read side: one retrieval call across knowledge + memory. */
export interface FederatedSearch {
  search(query: string, projectId: string, k?: number, scopes?: ReadonlySet<Scope>): Promise<Hit[]>;

  /** Return the full chunk; reject with UnknownChunkError if absent. */
  getChunk(chunkId: string): Promise<Chunk>;
}

/** Full knowledge-base surface: ingestion + federated retrieval. */
export interface KnowledgeBase extends FederatedSearch {
  /** Index a file or directory tree; optionally keep a file watcher on it. */
  ingest(path: string, projectId: string, watch?: boolean): Promise<IngestReport>;
}
