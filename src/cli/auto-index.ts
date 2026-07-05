/**
 * Auto-index the project into the knowledge base (tasks: mcp-serve auto-index +
 * semantic-upgrade "just works").
 *
 * A small `manifest.json` beside each collection records the EMBEDDER SIGNATURE
 * the index was built with. On `golem mcp serve` startup we (re)index when:
 *   - no manifest exists (first run — populate search without manual `golem index`), or
 *   - the signature changed (e.g. the user pulled bge-m3, so the embedder flips
 *     from lexical hashing to semantic bge-m3 — a stale-dimension index is cleared
 *     and rebuilt so the upgrade "just works").
 * When the signature already matches, it is a no-op (no wasteful re-embedding).
 *
 * Designed to run in the BACKGROUND (never blocks server startup); search returns
 * partial results until it finishes, then is complete.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { embedModelFor } from "../inference/index.js";
import type { HardwareTier } from "../interfaces/inference.js";
import type { KnowledgeBase } from "../interfaces/knowledge.js";
import { collectionDir, knowledgeDir } from "../knowledge/index.js";
import type { EmbedMode } from "./build-knowledge.js";

interface IndexManifest {
  readonly signature: string;
  readonly ts?: string;
  readonly paths?: readonly string[];
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

/** Record the embedder signature for a collection so later runs can skip/rebuild correctly. */
export async function writeManifest(
  projectDir: string,
  projectId: string,
  signature: string,
  paths: readonly string[],
  now: string,
): Promise<void> {
  const dir = collectionDir(knowledgeDir(projectDir), projectId);
  await mkdir(dir, { recursive: true });
  const manifest: IndexManifest = { signature, ts: now, paths };
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
  readonly action: "skipped" | "indexed" | "reindexed";
  readonly chunks: number;
  readonly files: number;
}

/**
 * Ensure the project is indexed with the CURRENT embedder. No-op when already
 * current; indexes on first run; clears + rebuilds when the embedder changed.
 */
export async function ensureProjectIndexed(
  opts: EnsureIndexedOptions,
): Promise<EnsureIndexedResult> {
  const dir = collectionDir(knowledgeDir(opts.projectDir), opts.projectId);
  const signature = embedderSignature(opts.embedMode, opts.tier);
  const manifest = await readManifest(dir);
  const log = opts.log ?? (() => {});

  if (manifest?.signature === signature) {
    return { action: "skipped", chunks: 0, files: 0 };
  }

  const reindex = manifest !== null;
  if (reindex) {
    log(`embedder changed (${manifest?.signature} → ${signature}) — re-indexing`);
    // Clear the stale-dimension vectors before the fresh embedder writes new ones.
    await rm(dir, { recursive: true, force: true });
  } else {
    log(`indexing project for search (${signature})`);
  }

  const paths = resolveIndexPaths(opts.projectDir, opts.watchPaths);
  let chunks = 0;
  let files = 0;
  for (const p of paths) {
    const report = await opts.knowledge.ingest(p, opts.projectId);
    chunks += report.chunksIndexed;
    files += report.filesSeen;
  }
  await writeManifest(opts.projectDir, opts.projectId, signature, paths, opts.now);
  log(`indexed ${chunks} chunks from ${files} file(s)`);
  return { action: reindex ? "reindexed" : "indexed", chunks, files };
}
