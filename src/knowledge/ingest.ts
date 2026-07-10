/**
 * WS-C C2 — ingestion traversal: walk a file or directory, pick chunkable
 * files, and produce prepared chunks. Cross-platform (node:fs/node:path);
 * skips vendored/build/VCS dirs and oversized files so a `golem index .` on a
 * real repo stays bounded. Embedding + vector upsert happen in the
 * KnowledgeBase (needs the WS-D embedder) — this module is pure I/O + chunking.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { chunkFile, isChunkableExtension, type RawChunk } from "./chunker.js";

/** A chunk ready to embed + store: raw chunk + source path (repo-relative). */
export interface PreparedChunk extends RawChunk {
  /** Path relative to the ingest root, POSIX-normalized for stable ids. */
  readonly sourcePath: string;
}

export interface IngestPlan {
  readonly chunks: readonly PreparedChunk[];
  readonly filesSeen: number;
  readonly filesSkipped: number;
}

/** Directories never walked (vendored, build output, VCS, Golem state). */
export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "coverage",
  ".golem",
  ".claude",
  ".next",
  ".cache",
  ".venv",
  "__pycache__",
  "target",
]);

/** Files larger than this are skipped (bytes) — avoids huge generated blobs. */
export const MAX_FILE_BYTES = 1_000_000;

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Recursively collect chunkable file paths under `root` (a dir or a file). */
async function collectFiles(root: string): Promise<{ seen: string[]; skipped: number }> {
  const seen: string[] = [];
  let skipped = 0;

  const info = await stat(root);
  if (info.isFile()) {
    if (isChunkableExtension(path.extname(root)) && info.size <= MAX_FILE_BYTES) seen.push(root);
    else skipped += 1;
    return { seen, skipped };
  }

  const walk = async (dir: string): Promise<void> => {
    // Inline options literal so TS picks the withFileTypes overload; `.catch`
    // avoids an explicit (mis-resolving) return-type annotation.
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (entries === null) return; // unreadable dir — skip quietly
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(full);
      } else if (entry.isFile()) {
        if (!isChunkableExtension(path.extname(entry.name))) {
          continue; // not a skip we count — just not a target type
        }
        try {
          const st = await stat(full);
          if (st.size > MAX_FILE_BYTES) {
            skipped += 1;
            continue;
          }
        } catch {
          skipped += 1;
          continue;
        }
        seen.push(full);
      }
    }
  };
  await walk(root);
  return { seen, skipped };
}

/**
 * Traverse `root`, chunk every chunkable file, and return prepared chunks with
 * repo-relative source paths. Does not embed or store.
 */
export async function planIngest(root: string): Promise<IngestPlan> {
  const absRoot = path.resolve(root);
  const { seen, skipped } = await collectFiles(absRoot);
  const rootIsFile = (await stat(absRoot)).isFile();
  const baseDir = rootIsFile ? path.dirname(absRoot) : absRoot;

  const chunks: PreparedChunk[] = [];
  let filesSkipped = skipped;
  for (const file of seen) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      filesSkipped += 1;
      continue;
    }
    const sourcePath = toPosix(path.relative(baseDir, file));
    for (const raw of chunkFile(file, content)) {
      chunks.push({ ...raw, sourcePath });
    }
  }
  return { chunks, filesSeen: seen.length, filesSkipped };
}

/** Deterministic chunk id from project + source + line span + content. */
export function chunkIdFor(projectId: string, chunk: PreparedChunk): string {
  return createHash("sha256")
    .update(`${projectId}\0${chunk.sourcePath}\0${chunk.startLine}\0${chunk.text}`)
    .digest("hex")
    .slice(0, 20);
}

/** One indexable file's identity for incremental change detection. */
export interface FileState {
  /** Absolute path. */
  readonly abs: string;
  /** Path relative to the scan root (POSIX) — matches chunk `sourcePath`. */
  readonly sourcePath: string;
  /** Last-modified epoch ms + byte size — the change signal. */
  readonly mtimeMs: number;
  readonly size: number;
}

/**
 * List the indexable files under `root` with their mtime/size — the same
 * traversal `planIngest` uses, but returning file identity instead of chunks, so
 * the auto-index can detect what changed since last time.
 */
export async function scanFiles(root: string): Promise<FileState[]> {
  const absRoot = path.resolve(root);
  const { seen } = await collectFiles(absRoot);
  const rootIsFile = (await stat(absRoot)).isFile();
  const baseDir = rootIsFile ? path.dirname(absRoot) : absRoot;
  const out: FileState[] = [];
  for (const abs of seen) {
    try {
      const st = await stat(abs);
      out.push({
        abs,
        sourcePath: toPosix(path.relative(baseDir, abs)),
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
    } catch {
      // vanished between walk and stat — ignore
    }
  }
  return out;
}

/**
 * Chunk specific files with `sourcePath` relative to `baseDir` (NOT each file's
 * own dir), so incremental re-ingest of one file produces the same source paths
 * as the original full index of the project root.
 */
export async function chunkFilesRelativeTo(
  files: readonly string[],
  baseDir: string,
): Promise<PreparedChunk[]> {
  const chunks: PreparedChunk[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const sourcePath = toPosix(path.relative(baseDir, file));
    for (const raw of chunkFile(file, content)) chunks.push({ ...raw, sourcePath });
  }
  return chunks;
}
