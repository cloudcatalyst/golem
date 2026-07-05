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
import { isDeletable, type StoredChunk, type VectorDriver } from "./driver.js";
import { chunkFilesRelativeTo, chunkIdFor, type PreparedChunk, planIngest } from "./ingest.js";

/** Turns text into embedding vectors. Supplied by WS-D InferenceService (C3). */
export type EmbedFn = (texts: readonly string[], kind: "text" | "code") => Promise<number[][]>;

/**
 * Optional capability (beyond the frozen KnowledgeBase): incremental re-index of
 * specific files, for the auto-index freshness sync. A KB exposes it only when
 * its driver supports deletion; callers check {@link supportsIncremental} and
 * fall back to a full re-index otherwise.
 */
export interface IncrementalIngest {
  /** True only when the backing driver + embedder can actually do incremental re-index. */
  readonly incrementalReady: boolean;
  /** Re-index the given files relative to `baseDir` (delete old chunks first). Returns chunks written. */
  reindexFiles(baseDir: string, projectId: string, absFiles: readonly string[]): Promise<number>;
  /** Drop all chunks for the given source paths (deleted files). Returns chunks removed. */
  removeSourcePaths(projectId: string, sourcePaths: readonly string[]): Promise<number>;
}

/** Structural check: can this KB do incremental re-index right now? */
export function supportsIncremental(kb: KnowledgeBase): kb is KnowledgeBase & IncrementalIngest {
  const c = kb as Partial<IncrementalIngest>;
  return (
    c.incrementalReady === true &&
    typeof c.reindexFiles === "function" &&
    typeof c.removeSourcePaths === "function"
  );
}

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

export class GolemKnowledgeBase implements KnowledgeBase, IncrementalIngest {
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
    const chunksIndexed = await this.#embedAndStore(projectId, plan.chunks);

    return {
      path: pathArg,
      projectId,
      filesSeen: plan.filesSeen,
      chunksIndexed,
      filesSkipped: plan.filesSkipped,
      watching: false,
    };
  }

  /** True only when the driver supports deletion AND an embedder is present. */
  get incrementalReady(): boolean {
    return this.#embed !== undefined && isDeletable(this.#driver);
  }

  /** {@link IncrementalIngest.reindexFiles} — replace each file's chunks in place. */
  async reindexFiles(
    baseDir: string,
    projectId: string,
    absFiles: readonly string[],
  ): Promise<number> {
    if (this.#embed === undefined || !isDeletable(this.#driver)) {
      throw new NotImplementedYetError("incremental re-index", "driver");
    }
    await this.#driver.openCollection(projectId);
    const chunks = await chunkFilesRelativeTo(absFiles, baseDir);
    // Clear each touched file's old chunks first (content-based ids would orphan).
    const sourcePaths = new Set(chunks.map((c) => c.sourcePath));
    for (const sp of sourcePaths) await this.#driver.deleteBySourcePath(projectId, sp);
    return this.#embedAndStore(projectId, chunks);
  }

  /** {@link IncrementalIngest.removeSourcePaths} — drop deleted files' chunks. */
  async removeSourcePaths(projectId: string, sourcePaths: readonly string[]): Promise<number> {
    if (!isDeletable(this.#driver)) {
      throw new NotImplementedYetError("incremental delete", "driver");
    }
    await this.#driver.openCollection(projectId);
    let removed = 0;
    for (const sp of sourcePaths) removed += await this.#driver.deleteBySourcePath(projectId, sp);
    return removed;
  }

  /** Embed prepared chunks (batched per kind) and upsert them; returns count stored. */
  async #embedAndStore(projectId: string, prepared: readonly PreparedChunk[]): Promise<number> {
    const embed = this.#embed;
    if (embed === undefined) throw new NotImplementedYetError("ingest (chunk embedding)", "C3");
    const byKind: Record<"text" | "code", PreparedChunk[]> = { text: [], code: [] };
    for (const c of prepared) byKind[c.kind].push(c);

    const stored: StoredChunk[] = [];
    for (const kind of ["text", "code"] as const) {
      const group = byKind[kind];
      if (group.length === 0) continue;
      const vectors = await embed(
        group.map((c) => c.text),
        kind,
      );
      for (let i = 0; i < group.length; i += 1) {
        const c = group[i];
        const vector = vectors[i];
        if (c === undefined || vector === undefined) continue;
        stored.push({
          chunk: {
            chunkId: chunkIdFor(projectId, c),
            projectId,
            text: c.text,
            sourcePath: c.sourcePath,
            startLine: c.startLine,
            endLine: c.endLine,
            metadata: c.metadata,
          },
          vector,
        });
      }
    }
    if (stored.length > 0) await this.#driver.upsert(projectId, stored);
    return stored.length;
  }
}

/** Narrowing helper: expose only the read side (FederatedSearch) when that's all a caller needs. */
export function asFederatedSearch(kb: KnowledgeBase): FederatedSearch {
  return kb;
}
