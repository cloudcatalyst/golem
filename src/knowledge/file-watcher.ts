/**
 * WS-C T6 (C2 follow-up) — cross-platform file watcher driving incremental KB
 * freshness. ONE backend on every OS: a manual per-directory, NON-recursive
 * `node:fs.watch` tree walk that adds a watcher per directory and picks up new
 * subdirectories as they appear.
 *
 * This supersedes ADR-0001's `fs.watch({ recursive: true })` on Windows/macOS:
 * libuv's recursive fs-event layer aborts the process on those platforms in some
 * environments — `Assertion failed: !_wcsnicmp(filename, dir, dirlen)`
 * (src\win\fs-event.c), a hard `abort()` that no `error` handler can catch —
 * which reliably reddened CI (verification-notes §68). The per-directory backend
 * only ever uses plain, non-recursive `fs.watch(dir)`, which does no event-path
 * prefix reconstruction and so never hits that assertion. It was already the
 * Linux backend (§51); using it everywhere trades a few more file handles for a
 * watcher that can't crash the host process. All events feed the same debounce +
 * re-stat batching layer, so a burst of writes (or a `git checkout`) collapses
 * into one reindex instead of one per file, and a half-written file never gets
 * chunked mid-save.
 */

import { type FSWatcher, watch as fsWatch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { isChunkableExtension } from "./chunker.js";
import { MAX_FILE_BYTES, SKIP_DIRS } from "./ingest.js";

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
}

export interface FileWatcher {
  /** Stop watching and release every underlying OS handle. */
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

/** Per-directory watchers over a tree, for platforms without reliable native recursion (Linux). */
class TreeWatcher {
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #root: string;
  readonly #onEvent: (absPath: string) => void;

  constructor(root: string, onEvent: (absPath: string) => void) {
    this.#root = root;
    this.#onEvent = onEvent;
  }

  async start(): Promise<void> {
    await this.#addDir(this.#root);
  }

  close(): void {
    for (const w of this.#watchers.values()) w.close();
    this.#watchers.clear();
  }

  async #addDir(dir: string): Promise<void> {
    if (this.#watchers.has(dir)) return;
    let watcher: FSWatcher;
    try {
      watcher = fsWatch(dir, (_eventType, filename) => {
        if (filename === null) return;
        const abs = path.join(dir, filename.toString());
        this.#onEvent(abs);
        void this.#maybeAddSubdir(abs);
      });
    } catch {
      return; // dir vanished (or is unwatchable) before we got to it — skip quietly
    }
    watcher.on("error", () => {
      this.#watchers.delete(dir); // fail-open: drop this subtree, keep the rest watching
    });
    this.#watchers.set(dir, watcher);

    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && !isIgnoredSegment(entry.name)) {
        await this.#addDir(path.join(dir, entry.name));
      }
    }
  }

  async #maybeAddSubdir(abs: string): Promise<void> {
    if (isIgnoredSegment(path.basename(abs))) return;
    try {
      const st = await stat(abs);
      if (st.isDirectory()) await this.#addDir(abs);
    } catch {
      // gone already (a delete, or briefly existed) — nothing to add
    }
  }
}

async function watchDirectoryTree(
  root: string,
  onEvent: (absPath: string) => void,
): Promise<{ close(): void }> {
  const tree = new TreeWatcher(root, onEvent);
  await tree.start();
  return tree;
}

function watchSingleFile(root: string, onEvent: (absPath: string) => void): { close(): void } {
  const watcher = fsWatch(root, () => onEvent(root));
  watcher.on("error", () => {});
  return { close: () => watcher.close() };
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
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = async (): Promise<void> => {
    timer = null;
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
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => void flush(), debounceMs);
  };

  const rootIsDir = (await stat(root)).isDirectory();
  const backend = rootIsDir
    ? await watchDirectoryTree(root, onEvent)
    : watchSingleFile(root, onEvent);

  return {
    close(): void {
      if (timer !== null) clearTimeout(timer);
      backend.close();
    },
  };
}
