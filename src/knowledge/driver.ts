/**
 * WS-C C1 — vector-store driver seam.
 *
 * The KnowledgeBase is store-agnostic: it talks to a `VectorDriver`, so the
 * embedded engine (LanceDB — decision memo, verification-notes §26) and a
 * Qdrant-server driver (config URL, spec Decision 12) are interchangeable, and
 * the native engine can be an OPTIONAL dependency lazily loaded behind this
 * seam (CLAUDE.md: no heavyweight native deps in the default install).
 *
 * `InMemoryVectorDriver` is a real, functional driver (cosine search, per-
 * project collections) used for tests and as the P0 non-durable default until
 * the embedded native driver lands. Durable drivers implement the same
 * interface; nothing above this seam changes.
 */

import type { Chunk } from "../interfaces/knowledge.js";

/** Current on-disk schema version; persisted drivers gate open() on it. */
export const KNOWLEDGE_SCHEMA_VERSION = 1;

/** A chunk plus its embedding, as stored. */
export interface StoredChunk {
  readonly chunk: Chunk;
  readonly vector: readonly number[];
}

/** One vector-search match (pre-rerank). */
export interface VectorMatch {
  readonly chunkId: string;
  readonly score: number;
}

/**
 * Thrown by a driver's `search` when the query vector's dimension does not match
 * the collection's stored vectors — i.e. the query was embedded in a DIFFERENT
 * space than the index was built in (e.g. a semantic embedder querying a
 * lexically-built index, or vice-versa). Cross-space cosine similarity is
 * meaningless (it would score every chunk 0), so this is surfaced loudly rather
 * than returning silent garbage. Recovery: rebuild the index with the current
 * embedder (`golem index`), or query with the embedder the index was built with.
 */
export class EmbedderMismatchError extends Error {
  constructor(
    readonly queryDim: number,
    readonly indexDim: number,
  ) {
    super(
      `query embedding is ${queryDim}-dim but the index was built with ${indexDim}-dim vectors — ` +
        "the index was built with a different embedder. Rebuild it with `golem index` " +
        "(or query with the embedder that built it).",
    );
    this.name = "EmbedderMismatchError";
  }
}

/**
 * Guard a search against a cross-embedder-space query. `indexDim` of 0 means an
 * empty/uninitialized collection — nothing to mismatch against, so it's a no-op.
 * Throws {@link EmbedderMismatchError} when a non-empty index is queried with a
 * differently-dimensioned vector.
 */
export function assertEmbedderSpaceMatch(queryDim: number, indexDim: number): void {
  if (indexDim > 0 && queryDim > 0 && queryDim !== indexDim) {
    throw new EmbedderMismatchError(queryDim, indexDim);
  }
}

/**
 * The store-agnostic vector driver. Per-project collections keep projects
 * isolated (spec Decision 3); `getChunk` is global because chunk ids are
 * unique across projects.
 */
export interface VectorDriver {
  readonly schemaVersion: number;
  /** Create/open a project collection. Idempotent. */
  openCollection(projectId: string): Promise<void>;
  /** Insert or replace records (by chunkId) in a project collection. */
  upsert(projectId: string, records: readonly StoredChunk[]): Promise<void>;
  /**
   * Top-k nearest neighbors in a project by cosine similarity, score desc.
   * Throws {@link EmbedderMismatchError} if `queryVector`'s dimension differs
   * from the collection's stored vectors (query embedded in a different space
   * than the index was built in) — the caller must never receive silently-wrong
   * (all-zero-score) results from a cross-space query.
   */
  search(projectId: string, queryVector: readonly number[], k: number): Promise<VectorMatch[]>;
  /** Full chunk by id, or null if absent (any project). */
  getChunk(chunkId: string): Promise<Chunk | null>;
  close(): Promise<void>;
}

/**
 * Optional capability (NOT part of the frozen {@link VectorDriver}): remove all
 * of a source file's chunks, so an edited/deleted file can be re-indexed cleanly
 * (chunk ids are content-based, so a changed file yields NEW ids and its old
 * chunks would otherwise orphan). Drivers that can't do this simply don't
 * implement it, and callers fall back to a full re-index.
 */
export interface DeletableVectorDriver extends VectorDriver {
  /** Remove every chunk in `projectId` whose `sourcePath` equals `sourcePath`; returns the count removed. */
  deleteBySourcePath(projectId: string, sourcePath: string): Promise<number>;
  /**
   * Batch form of {@link deleteBySourcePath}: remove every chunk whose
   * `sourcePath` is in `sourcePaths`, in ONE pass (and, for persisted drivers,
   * one flush). The incremental sync deletes many files per run — calling the
   * singular form in a loop rewrites the whole collection once per file.
   */
  deleteBySourcePaths(projectId: string, sourcePaths: readonly string[]): Promise<number>;
}

/** Structural check for {@link DeletableVectorDriver}. */
export function isDeletable(driver: VectorDriver): driver is DeletableVectorDriver {
  const d = driver as Partial<DeletableVectorDriver>;
  return typeof d.deleteBySourcePath === "function" && typeof d.deleteBySourcePaths === "function";
}

/** Cosine similarity; 0 when either vector is zero or dimensions mismatch. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * In-memory vector driver: functional (cosine search, per-project isolation)
 * but NOT durable — it exists so C1 has a working, dependency-free default and
 * a test double. Swap for a persisted driver (LanceDB) without touching callers.
 */
export class InMemoryVectorDriver implements DeletableVectorDriver {
  readonly schemaVersion = KNOWLEDGE_SCHEMA_VERSION;
  /** projectId -> (chunkId -> stored). */
  readonly #byProject = new Map<string, Map<string, StoredChunk>>();
  /** chunkId -> projectId, for global getChunk. */
  readonly #chunkIndex = new Map<string, string>();

  #collection(projectId: string): Map<string, StoredChunk> {
    let c = this.#byProject.get(projectId);
    if (c === undefined) {
      c = new Map();
      this.#byProject.set(projectId, c);
    }
    return c;
  }

  openCollection(projectId: string): Promise<void> {
    this.#collection(projectId);
    return Promise.resolve();
  }

  upsert(projectId: string, records: readonly StoredChunk[]): Promise<void> {
    const c = this.#collection(projectId);
    for (const rec of records) {
      c.set(rec.chunk.chunkId, rec);
      this.#chunkIndex.set(rec.chunk.chunkId, projectId);
    }
    return Promise.resolve();
  }

  search(projectId: string, queryVector: readonly number[], k: number): Promise<VectorMatch[]> {
    const c = this.#byProject.get(projectId);
    if (c === undefined || k <= 0) return Promise.resolve([]);
    const scored: VectorMatch[] = [];
    try {
      for (const rec of c.values()) {
        // Loud, not silent: a cross-space query would otherwise score 0 for every
        // chunk (dim-mismatch in cosineSimilarity) and return ranked garbage.
        // Reject (not sync-throw) to honor the Promise-returning contract.
        assertEmbedderSpaceMatch(queryVector.length, rec.vector.length);
        scored.push({
          chunkId: rec.chunk.chunkId,
          score: cosineSimilarity(queryVector, rec.vector),
        });
      }
    } catch (err) {
      return Promise.reject(err);
    }
    scored.sort((a, b) => b.score - a.score);
    return Promise.resolve(scored.slice(0, k));
  }

  getChunk(chunkId: string): Promise<Chunk | null> {
    const projectId = this.#chunkIndex.get(chunkId);
    if (projectId === undefined) return Promise.resolve(null);
    const rec = this.#byProject.get(projectId)?.get(chunkId);
    return Promise.resolve(rec?.chunk ?? null);
  }

  deleteBySourcePath(projectId: string, sourcePath: string): Promise<number> {
    return this.deleteBySourcePaths(projectId, [sourcePath]);
  }

  deleteBySourcePaths(projectId: string, sourcePaths: readonly string[]): Promise<number> {
    const c = this.#byProject.get(projectId);
    if (c === undefined || sourcePaths.length === 0) return Promise.resolve(0);
    const targets = new Set(sourcePaths);
    let removed = 0;
    for (const [id, rec] of c) {
      if (rec.chunk.sourcePath !== undefined && targets.has(rec.chunk.sourcePath)) {
        c.delete(id);
        this.#chunkIndex.delete(id);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
