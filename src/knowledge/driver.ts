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
  /** Top-k nearest neighbors in a project by cosine similarity, score desc. */
  search(projectId: string, queryVector: readonly number[], k: number): Promise<VectorMatch[]>;
  /** Full chunk by id, or null if absent (any project). */
  getChunk(chunkId: string): Promise<Chunk | null>;
  close(): Promise<void>;
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
export class InMemoryVectorDriver implements VectorDriver {
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
    for (const rec of c.values()) {
      scored.push({ chunkId: rec.chunk.chunkId, score: cosineSimilarity(queryVector, rec.vector) });
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

  close(): Promise<void> {
    return Promise.resolve();
  }
}
