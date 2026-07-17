/**
 * WS-C — durable, pure-TS vector driver (the default persisted store).
 *
 * §26 evaluated LanceDB and sqlite-vec and correctly ruled that BOTH are native
 * binaries, so either can only ship as an OPTIONAL add-on — which would leave the
 * default `npx golem-run` install with no persistence at all. This driver fills
 * that gap: it persists each project's `{chunk, vector}` records to disk as JSONL
 * and does the same brute-force cosine search as {@link InMemoryVectorDriver} on
 * an in-memory copy loaded at open. No native dependency (CLAUDE.md hard rule),
 * cross-platform (node:fs/path only).
 *
 * Scale note: brute-force cosine over a few thousand chunks is sub-millisecond;
 * LanceDB's ANN index only pays off at ~100k+ vectors, so it stays the documented
 * OPTIONAL scale upgrade behind this same `VectorDriver` seam (§26) — nothing
 * above the seam changes if a user opts into it.
 *
 * Durability: upserts rewrite the collection file atomically (tmp + rename), and
 * a `meta.json` carries {@link KNOWLEDGE_SCHEMA_VERSION} + the embedding
 * dimension. A schema/version mismatch on open is treated as empty (re-index)
 * rather than an error, and corrupt JSONL lines are skipped — the KB degrades,
 * never crashes.
 */

import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import type { Chunk } from "../interfaces/knowledge.js";
import {
  assertEmbedderSpaceMatch,
  cosineSimilarity,
  type DeletableVectorDriver,
  KNOWLEDGE_SCHEMA_VERSION,
  type StoredChunk,
  type VectorMatch,
} from "./driver.js";

/**
 * Filesystem-safe per-project collection directory under `baseDir`. Exported so
 * the auto-index manifest lives alongside a collection's data with ONE hashing
 * impl (projectId is often an absolute path).
 */
export function collectionDir(baseDir: string, projectId: string): string {
  const hash = createHash("sha256").update(projectId, "utf8").digest("hex").slice(0, 16);
  return path.join(baseDir, hash);
}

interface Collection {
  readonly dir: string;
  readonly records: Map<string, StoredChunk>;
  /** Embedding dimension seen so far (0 until the first non-empty vector). */
  dim: number;
}

interface PersistedMeta {
  readonly schemaVersion: number;
  readonly dim: number;
  readonly count: number;
}

export class FileVectorDriver implements DeletableVectorDriver {
  readonly schemaVersion = KNOWLEDGE_SCHEMA_VERSION;
  readonly #baseDir: string;
  /** projectId -> loaded collection. */
  readonly #collections = new Map<string, Collection>();
  /** chunkId -> projectId, for global getChunk over loaded collections. */
  readonly #chunkIndex = new Map<string, string>();

  constructor(baseDir: string) {
    this.#baseDir = baseDir;
  }

  #dirFor(projectId: string): string {
    return collectionDir(this.#baseDir, projectId);
  }

  async openCollection(projectId: string): Promise<void> {
    if (this.#collections.has(projectId)) return;
    const dir = this.#dirFor(projectId);
    const col: Collection = { dir, records: new Map(), dim: 0 };
    try {
      const metaRaw = await readFile(path.join(dir, "meta.json"), "utf8");
      const meta = JSON.parse(metaRaw) as Partial<PersistedMeta>;
      if (meta.schemaVersion === KNOWLEDGE_SCHEMA_VERSION) {
        col.dim = typeof meta.dim === "number" ? meta.dim : 0;
        await this.#loadChunks(dir, projectId, col);
      }
      // Version mismatch → leave the collection empty; the next upsert overwrites
      // the old files (re-index), so stale-schema data is never served.
    } catch {
      // No existing collection on disk — start empty.
    }
    this.#collections.set(projectId, col);
  }

  async #loadChunks(dir: string, projectId: string, col: Collection): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(path.join(dir, "chunks.jsonl"), "utf8");
    } catch {
      return; // meta without chunks — treat as empty
    }
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const rec = JSON.parse(line) as StoredChunk;
        if (rec.chunk?.chunkId !== undefined && Array.isArray(rec.vector)) {
          col.records.set(rec.chunk.chunkId, rec);
          this.#chunkIndex.set(rec.chunk.chunkId, projectId);
        }
      } catch {
        // Skip a corrupt line (e.g. a torn final write); the rest still loads.
      }
    }
  }

  async upsert(projectId: string, records: readonly StoredChunk[]): Promise<void> {
    await this.openCollection(projectId);
    const col = this.#collections.get(projectId);
    if (col === undefined) return; // unreachable: openCollection just set it
    // Embedder-space change (verification-notes §69 / PRE_R6_BATCH LE5c): if the
    // incoming vectors have a different dimension than the persisted collection,
    // the existing chunks were embedded by a different model and live in an
    // incompatible space — a mixed-dim collection is unqueryable
    // (`assertEmbedderSpaceMatch` rejects every query). `golem index` re-ingests
    // without clearing, so a lexical→semantic reindex (e.g. after `ollama pull
    // bge-m3`) would otherwise strand the old-dim chunks under the new signature.
    // Reset the collection to the new space rather than corrupt it.
    const incomingDim = records.find((r) => r.vector.length > 0)?.vector.length ?? 0;
    if (incomingDim > 0 && col.dim > 0 && incomingDim !== col.dim) {
      for (const id of col.records.keys()) this.#chunkIndex.delete(id);
      col.records.clear();
      col.dim = incomingDim;
    }
    for (const rec of records) {
      col.records.set(rec.chunk.chunkId, rec);
      this.#chunkIndex.set(rec.chunk.chunkId, projectId);
      if (col.dim === 0 && rec.vector.length > 0) col.dim = rec.vector.length;
    }
    await this.#flush(col);
  }

  async #flush(col: Collection): Promise<void> {
    await mkdir(col.dir, { recursive: true });
    // Atomic replace: stream records to a temp file then rename over the live
    // one so a crash mid-write never leaves a half-truncated collection.
    const tmp = path.join(col.dir, "chunks.jsonl.tmp");
    const dest = path.join(col.dir, "chunks.jsonl");
    await this.#writeRecordsStreamed(tmp, col.records.values());
    await rename(tmp, dest);
    const meta: PersistedMeta = {
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      dim: col.dim,
      count: col.records.size,
    };
    await writeFile(path.join(col.dir, "meta.json"), `${JSON.stringify(meta)}\n`, "utf8");
  }

  /**
   * Write one JSON line per record via a stream, honoring backpressure. R4.6
   * (r3.7-lancedb-scale-spike): the old `Array.join("\n")` built one string for
   * the entire collection and hard-crashed (`RangeError: Invalid string length`)
   * past ~30k-50k chunks — V8's max string length. Streaming line-by-line keeps
   * memory flat and removes the ceiling. `events.once(stream, "drain")` rejects
   * if the stream errors mid-wait, so an I/O failure surfaces instead of hanging.
   */
  async #writeRecordsStreamed(file: string, records: Iterable<StoredChunk>): Promise<void> {
    const stream = createWriteStream(file, { encoding: "utf8" });
    try {
      for (const rec of records) {
        if (!stream.write(`${JSON.stringify(rec)}\n`)) {
          await once(stream, "drain");
        }
      }
    } catch (err) {
      stream.destroy();
      throw err;
    }
    stream.end();
    await finished(stream);
  }

  async search(
    projectId: string,
    queryVector: readonly number[],
    k: number,
  ): Promise<VectorMatch[]> {
    await this.openCollection(projectId);
    const col = this.#collections.get(projectId);
    if (col === undefined || k <= 0) return [];
    // Loud, not silent: a query embedded in a different space than the index was
    // built in (e.g. semantic vectors against a lexically-built index) would
    // score 0 for every chunk and return ranked garbage. `col.dim` is the
    // persisted build-time dimension (meta.json).
    assertEmbedderSpaceMatch(queryVector.length, col.dim);
    const scored: VectorMatch[] = [];
    for (const rec of col.records.values()) {
      scored.push({ chunkId: rec.chunk.chunkId, score: cosineSimilarity(queryVector, rec.vector) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  async getChunk(chunkId: string): Promise<Chunk | null> {
    const projectId = this.#chunkIndex.get(chunkId);
    if (projectId === undefined) return null;
    return this.#collections.get(projectId)?.records.get(chunkId)?.chunk ?? null;
  }

  /** Remove all of one source file's chunks (for incremental re-index). Flushes if any changed. */
  deleteBySourcePath(projectId: string, sourcePath: string): Promise<number> {
    return this.deleteBySourcePaths(projectId, [sourcePath]);
  }

  /**
   * Batch removal with a SINGLE flush — the whole collection file is rewritten
   * once, not once per source path (the incremental sync deletes many files per
   * run, so per-path flushing is O(files × collection size) in write I/O).
   */
  async deleteBySourcePaths(projectId: string, sourcePaths: readonly string[]): Promise<number> {
    await this.openCollection(projectId);
    const col = this.#collections.get(projectId);
    if (col === undefined || sourcePaths.length === 0) return 0;
    const targets = new Set(sourcePaths);
    let removed = 0;
    for (const [id, rec] of col.records) {
      if (rec.chunk.sourcePath !== undefined && targets.has(rec.chunk.sourcePath)) {
        col.records.delete(id);
        this.#chunkIndex.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) await this.#flush(col);
    return removed;
  }

  async close(): Promise<void> {
    // Every upsert flushes synchronously to disk, so there is nothing buffered.
  }
}
