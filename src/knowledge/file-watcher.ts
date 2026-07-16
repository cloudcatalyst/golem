/**
 * WS-C T6 — cross-platform file watcher driving incremental KB freshness.
 *
 * POLLING backend on every OS: scan the tree ({@link scanFiles} — SKIP_DIRS-
 * pruned, chunkable files only) on an interval and diff mtime/size against the
 * previous snapshot. It deliberately does NOT use `node:fs.watch`.
 *
 * Why not fs.watch: libuv's Windows/macOS fs-event layer aborts the PROCESS —
 * uncatchable, no `error` event — via `uv__relative_path`'s
 * `assert(!_wcsnicmp(filename, dir, dirlen))` (src\win\fs-event.c) whenever
 * `GetLongPathNameW` of a changed file's full path doesn't prefix-match the
 * watched directory it stored at start. That path is taken for EVERY directory
 * watch, recursive or not (the recursive flag only sets `ReadDirectoryChangesW`'s
 * subtree bit), so neither `{recursive:true}` nor a per-directory non-recursive
 * watch avoids it, and canonicalizing the watched path doesn't either (Node's
 * `realpath` ≠ Windows `GetLongPathNameW` semantics). It fires on some
 * environments' path shapes (GitHub runner temp junction/8.3) and could crash a
 * real Windows user; it reliably reddened CI (verification-notes §68).
 *
 * Polling can't crash, needs no per-platform branch, and — being the same code
 * on every OS — means Linux CI actually exercises what Windows/macOS run. Cost:
 * change latency up to `pollMs` and a periodic stat-scan (bounded by SKIP_DIRS);
 * fine for opt-in KB freshness. Detected changes feed a debounce + re-stat
 * batching layer, so a burst of writes (or a `git checkout`) collapses into one
 * batch and a half-written file gets a moment to settle before it's classified.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import { isChunkableExtension } from "./chunker.js";
import { MAX_FILE_BYTES, SKIP_DIRS, scanFiles } from "./ingest.js";

/** One debounced round of changes, classified by whether the path still exists. */
export interface FileChangeBatch {
  /** Absolute paths of chunkable files that exist and changed (created or modified). */
  readonly changed: readonly string[];
  /** Absolute paths that no longer exist (deleted, or renamed away). */
  readonly removed: readonly string[];
}

export interface FileWatcherOptions {
  /** Debounce window in ms — events within this window collapse into one batch. Default 500. */
  readonly debounceMs?: number;
  /** Poll interval in ms — how often the tree is re-scanned for changes. Default 1000. */
  readonly pollMs?: number;
}

export interface FileWatcher {
  /** Stop watching and release every underlying resource. */
  close(): void;
}

function isIgnoredSegment(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith(".");
}

/** True if any directory segment between `root` and `absPath` (excluding the leaf) is skipped. */
function isIgnoredPath(root: string, absPath: string): boolean {
  const rel = path.relative(root, absPath);
  const segments = rel.split(path.sep);
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i];
    if (seg !== undefined && isIgnoredSegment(seg)) return true;
  }
  return false;
}

/** Snapshot of the watched tree: absolute path → `mtimeMs:size` change signal. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const f of await scanFiles(root)) map.set(f.abs, `${f.mtimeMs}:${f.size}`);
  return map;
}

/**
 * Watch `root` (a file or a directory) for changes, debounced and re-stat'd
 * into one {@link FileChangeBatch} per quiet period. There is no per-event
 * callback by design — a burst of saves (or a `git checkout`) collapses into
 * one batch instead of one reindex per file.
 */
export async function watchPath(
  root: string,
  onBatch: (batch: FileChangeBatch) => void,
  options: FileWatcherOptions = {},
): Promise<FileWatcher> {
  const debounceMs = options.debounceMs ?? 500;
  const pollMs = options.pollMs ?? 1000;
  const pending = new Set<string>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = async (): Promise<void> => {
    debounceTimer = null;
    if (pending.size === 0) return;
    const paths = [...pending];
    pending.clear();
    const changed: string[] = [];
    const removed: string[] = [];
    for (const p of paths) {
      if (isIgnoredPath(root, p) || !isChunkableExtension(path.extname(p))) continue;
      try {
        const st = await stat(p);
        if (st.isFile() && st.size <= MAX_FILE_BYTES) changed.push(p);
      } catch {
        removed.push(p);
      }
    }
    if (changed.length > 0 || removed.length > 0) onBatch({ changed, removed });
  };

  const onEvent = (absPath: string): void => {
    pending.add(absPath);
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void flush(), debounceMs);
  };

  // Baseline snapshot: only changes AFTER watch start are reported.
  let prev = await snapshot(root);
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const poll = async (): Promise<void> => {
    let cur: Map<string, string>;
    try {
      cur = await snapshot(root);
    } catch {
      return; // root briefly unreadable (mid-rename, etc.) — try again next tick
    }
    for (const [abs, sig] of cur) {
      if (prev.get(abs) !== sig) onEvent(abs); // created or modified
    }
    for (const abs of prev.keys()) {
      if (!cur.has(abs)) onEvent(abs); // deleted (or renamed away)
    }
    prev = cur;
  };

  // Self-scheduling (not setInterval) so a slow scan on a big tree never overlaps.
  const loop = async (): Promise<void> => {
    if (stopped) return;
    await poll();
    if (!stopped) pollTimer = setTimeout(() => void loop(), pollMs);
  };
  pollTimer = setTimeout(() => void loop(), pollMs);

  return {
    close(): void {
      stopped = true;
      if (pollTimer !== null) clearTimeout(pollTimer);
      if (debounceTimer !== null) clearTimeout(debounceTimer);
    },
  };
}
