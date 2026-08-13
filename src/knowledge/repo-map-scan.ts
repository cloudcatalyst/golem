/**
 * R8.5 — the repo map's SCAN stage: walk the tree, parse every
 * symbol-extractable file, and cache the facts. Extracted verbatim from
 * `./repo-map.js`.
 *
 * tree-sitter is a tier-2 optional dep (Decision 53). Absent,
 * {@link scanRepoFiles} simply returns no files and the map reports
 * `available: false` — a no-op, never an error path.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { scanFiles } from "./ingest.js";
import { extractFileFacts, type FileFacts, isSymbolExtractable } from "./tree-sitter-chunker.js";

/** Files parsed at most, newest-mtime-first, so a monorepo cannot hang a call. */
export const MAX_FILES_PARSED = 1_500;

/** One scanned, parsed file. */
export interface RepoFile {
  /** POSIX path relative to the map root. */
  readonly sourcePath: string;
  readonly lines: number;
  readonly facts: FileFacts;
}

/**
 * Parsed facts keyed by absolute path, invalidated on mtime/size — the cheap
 * half of "incrementally refreshed" (ADR-0001's watcher is the other half).
 * Parsing this repo costs ~1.5s cold; a second map in the same process, e.g. the
 * model asking again with a different query, then costs the walk alone.
 */
const factsCache = new Map<
  string,
  { readonly mtimeMs: number; readonly size: number; readonly file: RepoFile }
>();

/** Drop the parse cache — for tests and for an explicit re-index. */
export function clearRepoMapCache(): void {
  factsCache.clear();
}

/**
 * Parse every symbol-extractable file under `root`. Reuses the ingest walk, so
 * the map covers exactly the tree the knowledge base indexes (same `SKIP_DIRS`,
 * same size cap) and inherits the watcher's notion of the project.
 */
export async function scanRepoFiles(root: string): Promise<RepoFile[]> {
  const all = await scanFiles(root);
  const targets = all
    .filter((f) => isSymbolExtractable(path.extname(f.sourcePath).toLowerCase()))
    .sort((a, b) => (a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0))
    .slice(0, MAX_FILES_PARSED);

  const out: RepoFile[] = [];
  for (const target of targets) {
    const cached = factsCache.get(target.abs);
    if (
      cached !== undefined &&
      cached.mtimeMs === target.mtimeMs &&
      cached.size === target.size &&
      cached.file.sourcePath === target.sourcePath
    ) {
      out.push(cached.file);
      continue;
    }
    let content: string;
    try {
      content = await readFile(target.abs, "utf8");
    } catch {
      continue; // vanished or unreadable — not an error path
    }
    const facts = await extractFileFacts(path.extname(target.sourcePath).toLowerCase(), content);
    if (facts === null) continue; // tree-sitter absent or parse failure — drop the file
    const file: RepoFile = {
      sourcePath: target.sourcePath,
      lines: content.split("\n").length,
      facts,
    };
    factsCache.set(target.abs, { mtimeMs: target.mtimeMs, size: target.size, file });
    out.push(file);
  }
  return out;
}
