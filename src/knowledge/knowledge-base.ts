/**
 * WS-C C1 — GolemKnowledgeBase: the store-agnostic KnowledgeBase over a
 * VectorDriver.
 *
 * Read path (C1): text `search` via an injected embed function + `getChunk`;
 * per-project isolation; KNOWLEDGE-only degradation. Write path (C2): `ingest`
 * traverses + chunks a file/dir (chunker.ts), embeds each chunk via the
 * injected embedder, and upserts vectors. The embedder itself is wired to WS-D
 * in C3 — without one, `ingest`/`search` raise NotImplementedYetError. MEMORY
 * federation needs the Headroom Python sidecar (Decisions 13/18); absent it,
 * search degrades to KNOWLEDGE only (documented P0 behavior).
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
import type { StoredChunk, VectorDriver } from "./driver.js";
import { chunkIdFor, type PreparedChunk, planIngest } from "./ingest.js";

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

  async ingest(pathArg: string, projectId: string, watch?: boolean): Promise<IngestReport> {
    if (watch === true) {
      // File watching (fs.watch/chokidar decision, verification-notes §27) is a
      // C2 follow-up; refuse rather than silently not-watching.
      throw new NotImplementedYetError("file watching", "C2-followup");
    }
    if (this.#embed === undefined) {
      // Chunking works without an embedder, but storing vectors needs one
      // (wired to WS-D in C3).
      throw new NotImplementedYetError("ingest (chunk embedding)", "C3");
    }

    const plan = await planIngest(pathArg);
    await this.#driver.openCollection(projectId);

    // Embed in batches per kind (text vs code use different models), preserving
    // order so vectors line up with their chunks.
    const byKind: Record<"text" | "code", PreparedChunk[]> = { text: [], code: [] };
    for (const c of plan.chunks) byKind[c.kind].push(c);

    const stored: StoredChunk[] = [];
    for (const kind of ["text", "code"] as const) {
      const group = byKind[kind];
      if (group.length === 0) continue;
      const vectors = await this.#embed(
        group.map((c) => c.text),
        kind,
      );
      for (let i = 0; i < group.length; i += 1) {
        const c = group[i];
        const vector = vectors[i];
        if (c === undefined || vector === undefined) continue;
        const chunk: Chunk = {
          chunkId: chunkIdFor(projectId, c),
          projectId,
          text: c.text,
          sourcePath: c.sourcePath,
          startLine: c.startLine,
          endLine: c.endLine,
          metadata: c.metadata,
        };
        stored.push({ chunk, vector });
      }
    }
    if (stored.length > 0) await this.#driver.upsert(projectId, stored);

    return {
      path: pathArg,
      projectId,
      filesSeen: plan.filesSeen,
      chunksIndexed: stored.length,
      filesSkipped: plan.filesSkipped,
      watching: false,
    };
  }
}

/** Narrowing helper: expose only the read side (FederatedSearch) when that's all a caller needs. */
export function asFederatedSearch(kb: KnowledgeBase): FederatedSearch {
  return kb;
}
