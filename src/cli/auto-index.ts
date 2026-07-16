/**
 * Auto-index the project into the knowledge base (mcp-serve auto-index +
 * semantic-upgrade + incremental freshness).
 *
 * A `manifest.json` beside each collection records the EMBEDDER SIGNATURE and a
 * per-file state map (`sourcePath → mtime/size`). On `golem mcp serve` startup:
 *   - no manifest        → first-run full index (populate search, no manual step),
 *   - signature changed  → clear + full rebuild (e.g. user pulled bge-m3),
 *   - signature matches   → INCREMENTAL sync: re-index only changed/new files and
 *     drop deleted files' chunks (so edits are reflected without a full rebuild),
 *   - nothing changed    → no-op.
 * Incremental needs a deletable driver + a single index root; otherwise a change
 * falls back to a full rebuild. Runs in the BACKGROUND — never blocks startup.
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { embedModelFor } from "../inference/index.js";
import type { HardwareTier } from "../interfaces/inference.js";
import type { KnowledgeBase } from "../interfaces/knowledge.js";
import {
  collectionDir,
  type FileState,
  knowledgeDir,
  scanFiles,
  supportsIncremental,
} from "../knowledge/index.js";
import type { EmbedMode } from "./build-knowledge.js";

/** Per-file change signal persisted in the manifest. */
interface PersistedFileState {
  /** mtime epoch ms. */
  readonly m: number;
  /** byte size. */
  readonly s: number;
}

interface IndexManifest {
  readonly signature: string;
  readonly ts?: string;
  readonly paths?: readonly string[];
  readonly files?: Readonly<Record<string, PersistedFileState>>;
}

/**
 * A stable identity for the embedder that built an index. Changing embedder
 * (lexical hashing ↔ a specific Ollama model) changes vector space + dimension,
 * so a signature mismatch means the index must be rebuilt.
 */
export function embedderSignature(mode: EmbedMode, tier: HardwareTier): string {
  return mode === "semantic" ? `semantic:${embedModelFor(tier, "text")}` : "lexical:hash-v1-512";
}

/** Paths to auto-index: configured `watch_paths` (relative → project-rooted), else the project root. */
export function resolveIndexPaths(projectDir: string, watchPaths: readonly string[]): string[] {
  if (watchPaths.length === 0) return [projectDir];
  return watchPaths.map((p) => (path.isAbsolute(p) ? p : path.join(projectDir, p)));
}

async function readManifest(dir: string): Promise<IndexManifest | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as IndexManifest;
  } catch {
    return null;
  }
}

/**
 * Which embedder space an EXISTING project index was built in, read back from
 * its persisted manifest signature (see {@link embedderSignature}). A query MUST
 * be embedded in this same space or it silently scores 0 against every chunk
 * (guarded by `assertEmbedderSpaceMatch`), so query-side callers (the proxy's
 * local-answer KB) use this to pick a matching embedder rather than a blind
 * "is Ollama up?" probe. Returns `null` when there is no index yet, or the
 * manifest is missing/unreadable/unrecognized.
 */
export async function resolvePersistedEmbedMode(
  projectDir: string,
  projectId: string,
): Promise<EmbedMode | null> {
  const dir = collectionDir(knowledgeDir(projectDir), projectId);
  const manifest = await readManifest(dir);
  const signature = manifest?.signature;
  if (typeof signature !== "string") return null;
  if (signature.startsWith("semantic:")) return "semantic";
  if (signature.startsWith("lexical:")) return "lexical";
  return null;
}

/** Scan all roots into a `sourcePath → FileState` map (last-writer-wins across roots). */
async function scanAll(roots: readonly string[]): Promise<Map<string, FileState>> {
  const map = new Map<string, FileState>();
  for (const root of roots) {
    for (const f of await scanFiles(root)) map.set(f.sourcePath, f);
  }
  return map;
}

function toPersisted(states: Map<string, FileState>): Record<string, PersistedFileState> {
  const out: Record<string, PersistedFileState> = {};
  for (const [sp, f] of states) out[sp] = { m: f.mtimeMs, s: f.size };
  return out;
}

/** Record the manifest (embedder signature + file states) for a collection. */
export async function writeManifest(
  projectDir: string,
  projectId: string,
  signature: string,
  paths: readonly string[],
  now: string,
  files: Readonly<Record<string, PersistedFileState>> = {},
): Promise<void> {
  const dir = collectionDir(knowledgeDir(projectDir), projectId);
  await mkdir(dir, { recursive: true });
  const manifest: IndexManifest = { signature, ts: now, paths, files };
  await writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
}

export interface EnsureIndexedOptions {
  readonly projectDir: string;
  readonly projectId: string;
  readonly knowledge: KnowledgeBase;
  readonly embedMode: EmbedMode;
  readonly tier: HardwareTier;
  readonly watchPaths: readonly string[];
  /** Current time (ISO); injected so callers/tests control it. */
  readonly now: string;
  readonly log?: (msg: string) => void;
}

/** Outcome of an {@link ensureProjectIndexed} run (handy for logs/tests). */
export interface EnsureIndexedResult {
  readonly action: "skipped" | "indexed" | "reindexed" | "synced";
  readonly chunks: number;
  readonly files: number;
  /** Incremental only: files changed/added and removed. */
  readonly updated?: number;
  readonly removed?: number;
}

/** Full (re)index of every root, then persist the manifest with fresh file states. */
async function fullIndex(
  opts: EnsureIndexedOptions,
  roots: readonly string[],
  signature: string,
): Promise<{ chunks: number; files: number }> {
  let chunks = 0;
  let files = 0;
  for (const root of roots) {
    const report = await opts.knowledge.ingest(root, opts.projectId);
    chunks += report.chunksIndexed;
    files += report.filesSeen;
  }
  const states = await scanAll(roots);
  await writeManifest(
    opts.projectDir,
    opts.projectId,
    signature,
    roots,
    opts.now,
    toPersisted(states),
  );
  return { chunks, files };
}

/**
 * Ensure the project index matches the current embedder AND current files. Full
 * (re)build on first run / embedder change; otherwise an incremental sync of just
 * what changed; no-op when nothing changed.
 */
export async function ensureProjectIndexed(
  opts: EnsureIndexedOptions,
): Promise<EnsureIndexedResult> {
  const dir = collectionDir(knowledgeDir(opts.projectDir), opts.projectId);
  const signature = embedderSignature(opts.embedMode, opts.tier);
  const manifest = await readManifest(dir);
  const roots = resolveIndexPaths(opts.projectDir, opts.watchPaths);
  const log = opts.log ?? (() => {});

  // First run or embedder change → full (re)build.
  if (manifest?.signature !== signature) {
    if (manifest !== null) {
      log(`embedder changed (${manifest.signature} → ${signature}) — re-indexing`);
      await rm(dir, { recursive: true, force: true });
    } else {
      log(`indexing project for search (${signature})`);
    }
    const { chunks, files } = await fullIndex(opts, roots, signature);
    log(`indexed ${chunks} chunks from ${files} file(s)`);
    return { action: manifest !== null ? "reindexed" : "indexed", chunks, files };
  }

  // Signature matches → incremental sync of changed/new/deleted files.
  const current = await scanAll(roots);
  const prev = manifest.files ?? {};
  const changed: string[] = [];
  for (const [sp, f] of current) {
    const p = prev[sp];
    if (p === undefined || p.m !== f.mtimeMs || p.s !== f.size) changed.push(f.abs);
  }
  const deleted = Object.keys(prev).filter((sp) => !current.has(sp));
  if (changed.length === 0 && deleted.length === 0) {
    return { action: "skipped", chunks: 0, files: 0 };
  }

  // Incremental needs a deletable driver + a single (directory) root so source
  // paths line up; otherwise fall back to a full rebuild.
  const singleDirRoot =
    roots.length === 1 &&
    roots[0] !== undefined &&
    (await stat(roots[0]).catch(() => null))?.isDirectory();
  if (!supportsIncremental(opts.knowledge) || singleDirRoot !== true || roots[0] === undefined) {
    log(`${changed.length + deleted.length} change(s) — rebuilding index`);
    await rm(dir, { recursive: true, force: true });
    const { chunks, files } = await fullIndex(opts, roots, signature);
    return { action: "reindexed", chunks, files };
  }

  const baseDir = roots[0];
  const chunks = await opts.knowledge.reindexFiles(baseDir, opts.projectId, changed);
  const removed = await opts.knowledge.removeSourcePaths(opts.projectId, deleted);
  await writeManifest(
    opts.projectDir,
    opts.projectId,
    signature,
    roots,
    opts.now,
    toPersisted(current),
  );
  log(`synced: ${changed.length} changed, ${deleted.length} removed`);
  return {
    action: "synced",
    chunks,
    files: current.size,
    updated: changed.length,
    removed,
  };
}
