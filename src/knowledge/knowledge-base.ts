/**
 * WS-C C1 — GolemKnowledgeBase: the store-agnostic KnowledgeBase over a
 * VectorDriver.
 *
 * Scope of C1: the READ path (text `search` via an injected embed function +
 * `getChunk`) is real; per-project isolation and KNOWLEDGE-only degradation are
 * implemented. `ingest` needs heading/code chunking (C2) and embedding (C3), so
 * it is a clearly-signalled TODO here. MEMORY-scope federation needs the
 * Headroom Python sidecar (spec Decisions 13/18) — absent it, search silently
 * degrades to KNOWLEDGE only, which is the documented P0 behavior.
 */

import {
  type Chunk,
  DEFAULT_SCOPES,
  type FederatedSearch,
  type Hit,
  type IngestReport,
  type KnowledgeBase,
  type Scope,
  UnknownChunkError,
} from "../interfaces/knowledge.js";
import type { VectorDriver } from "./driver.js";

/** Turns text into embedding vectors. Supplied by WS-D InferenceService (C3). */
export type EmbedFn = (texts: readonly string[], kind: "text" | "code") => Promise<number[][]>;

/** Thrown by surfaces not implemented until a later WS-C task. */
export class NotImplementedYetError extends Error {
  constructor(what: string, task: string) {
    super(`${what} is not implemented yet (ships with WS-C ${task})`);
    this.name = "NotImplementedYetError";
  }
}

export interface KnowledgeBaseOptions {
  /**
   * Text→vector embedder (WS-D). Without it, KNOWLEDGE text search cannot run
   * and throws NotImplementedYetError — wired in C3.
   */
  readonly embed?: EmbedFn;
}

export class GolemKnowledgeBase implements KnowledgeBase {
  readonly #driver: VectorDriver;
  readonly #embed: EmbedFn | undefined;

  constructor(driver: VectorDriver, options: KnowledgeBaseOptions = {}) {
    this.#driver = driver;
    this.#embed = options.embed;
  }

  async search(
    query: string,
    projectId: string,
    k = 8,
    scopes: ReadonlySet<Scope> = DEFAULT_SCOPES,
  ): Promise<Hit[]> {
    // MEMORY scope requires the Headroom sidecar (Python-only, Decisions 13/18).
    // It is not available in the default install → degrade to KNOWLEDGE only.
    if (!scopes.has("knowledge")) {
      return []; // memory-only request with no sidecar: nothing to serve
    }
    if (this.#embed === undefined) {
      throw new NotImplementedYetError("text search (query embedding)", "C3");
    }
    const [queryVector] = await this.#embed([query], "text");
    if (queryVector === undefined) return [];
    const matches = await this.#driver.search(projectId, queryVector, k);
    const hits: Hit[] = [];
    for (const m of matches) {
      const chunk = await this.#driver.getChunk(m.chunkId);
      if (chunk !== null) hits.push({ chunk, score: m.score, scope: "knowledge" });
    }
    return hits;
  }

  async getChunk(chunkId: string): Promise<Chunk> {
    const chunk = await this.#driver.getChunk(chunkId);
    if (chunk === null) throw new UnknownChunkError(chunkId);
    return chunk;
  }

  ingest(_path: string, _projectId: string, _watch?: boolean): Promise<IngestReport> {
    // Chunking (heading-aware md/html, code via tree-sitter) is C2; embedding is
    // C3. Until both land, ingest is intentionally unavailable rather than
    // silently indexing nothing.
    return Promise.reject(new NotImplementedYetError("ingest (chunking + embedding)", "C2/C3"));
  }
}

/** Narrowing helper: expose only the read side (FederatedSearch) when that's all a caller needs. */
export function asFederatedSearch(kb: KnowledgeBase): FederatedSearch {
  return kb;
}
