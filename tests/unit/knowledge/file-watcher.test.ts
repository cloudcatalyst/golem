/**
 * T6 (C2 follow-up) — watchPath: debounce/batch + re-stat classification, and
 * the two ADR-0001 backends (native recursive on win32/darwin, per-directory
 * tree walk everywhere else, forced here via the `platform` test override so
 * both are exercised regardless of the host OS running the suite).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FileChangeBatch, FileWatcher } from "../../../src/knowledge/file-watcher.js";
import { watchPath } from "../../../src/knowledge/file-watcher.js";

let dir: string;
let watcher: FileWatcher | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "golem-watch-"));
});

afterEach(async () => {
  watcher?.close();
  watcher = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** Polls the collected-batches array until one arrives, merging none. */
async function nextBatch(batches: FileChangeBatch[], timeoutMs = 4000): Promise<FileChangeBatch> {
  const start = Date.now();
  while (batches.length === 0) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for a batch");
    await new Promise((r) => setTimeout(r, 20));
  }
  const batch = batches.shift();
  if (batch === undefined) throw new Error("unreachable");
  return batch;
}

/** True for the whole timeout window if no batch ever arrives. */
async function staysQuiet(batches: FileChangeBatch[], windowMs = 700): Promise<boolean> {
  await new Promise((r) => setTimeout(r, windowMs));
  return batches.length === 0;
}

describe("watchPath", () => {
  it("debounces a burst of writes into a single batch", async () => {
    const batches: FileChangeBatch[] = [];
    watcher = await watchPath(dir, (b) => batches.push(b), { debounceMs: 150 });
    const file = path.join(dir, "note.md");
    await writeFile(file, "one");
    await writeFile(file, "two");
    await writeFile(file, "three");

    const batch = await nextBatch(batches);
    expect(batch.changed).toEqual([file]);
    expect(batch.removed).toEqual([]);
    expect(await staysQuiet(batches, 300)).toBe(true);
  });

  it("reports a deleted file as removed", async () => {
    const file = path.join(dir, "gone.md");
    await writeFile(file, "content");
    const batches: FileChangeBatch[] = [];
    watcher = await watchPath(dir, (b) => batches.push(b), { debounceMs: 150 });

    await rm(file);
    const batch = await nextBatch(batches);
    expect(batch.removed).toEqual([file]);
    expect(batch.changed).toEqual([]);
  });

  it("ignores files under a skipped directory (e.g. node_modules)", async () => {
    await mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
    const batches: FileChangeBatch[] = [];
    watcher = await watchPath(dir, (b) => batches.push(b), {
      debounceMs: 150,
      platform: "linux",
    });

    await writeFile(path.join(dir, "node_modules", "pkg", "index.js"), "noise");
    expect(await staysQuiet(batches)).toBe(true);

    // Same watcher, a real file — proves it's alive, not just quiet.
    const tracked = path.join(dir, "real.md");
    await writeFile(tracked, "signal");
    const batch = await nextBatch(batches);
    expect(batch.changed).toEqual([tracked]);
  });

  it("ignores non-chunkable extensions", async () => {
    const batches: FileChangeBatch[] = [];
    watcher = await watchPath(dir, (b) => batches.push(b), { debounceMs: 150 });

    await writeFile(path.join(dir, "image.png"), "binary-ish");
    expect(await staysQuiet(batches)).toBe(true);

    const tracked = path.join(dir, "real.ts");
    await writeFile(tracked, "export const x = 1;");
    const batch = await nextBatch(batches);
    expect(batch.changed).toEqual([tracked]);
  });

  it("close() stops further batches", async () => {
    const batches: FileChangeBatch[] = [];
    const w = await watchPath(dir, (b) => batches.push(b), { debounceMs: 150 });
    w.close();

    await writeFile(path.join(dir, "after-close.md"), "content");
    expect(await staysQuiet(batches)).toBe(true);
  });

  describe("Linux per-directory tree watcher (forced via platform override)", () => {
    it("picks up a file created in a new subdirectory", async () => {
      const batches: FileChangeBatch[] = [];
      watcher = await watchPath(dir, (b) => batches.push(b), {
        debounceMs: 150,
        platform: "linux",
      });

      const subdir = path.join(dir, "sub");
      await mkdir(subdir);
      const nested = path.join(subdir, "deep.md");
      await writeFile(nested, "content");

      const batch = await nextBatch(batches, 6000);
      expect(batch.changed).toEqual([nested]);
    });
  });

  describe("native recursive backend (win32/darwin only)", () => {
    const supported = process.platform === "win32" || process.platform === "darwin";

    it.runIf(supported)("picks up changes nested more than one level deep", async () => {
      const subdir = path.join(dir, "a", "b");
      await mkdir(subdir, { recursive: true });
      const batches: FileChangeBatch[] = [];
      watcher = await watchPath(dir, (b) => batches.push(b), { debounceMs: 150 });

      const nested = path.join(subdir, "deep.md");
      await writeFile(nested, "content");

      const batch = await nextBatch(batches, 6000);
      expect(batch.changed).toEqual([nested]);
    });
  });
});
