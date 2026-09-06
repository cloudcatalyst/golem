/**
 * T6 — watchPath: debounce/batch + re-stat classification over the single
 * POLLING (scan + mtime/size diff) backend used on every OS (verification-notes
 * §68 — `node:fs.watch` aborts the process on Windows/macOS). Tests pass a small
 * `pollMs` so detection is fast and deterministic; nested-subdir coverage runs
 * on all platforms, since there is one backend.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileChangeBatch, FileWatcher } from "../../../src/knowledge/file-watcher.js";
import { watchPath } from "../../../src/knowledge/file-watcher.js";
import { rmTemp } from "../../helpers/tmp.js";

let dir: string;
let watcher: FileWatcher | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "golem-watch-"));
});

afterEach(async () => {
  watcher?.close();
  watcher = undefined;
  vi.useRealTimers();
  await rm(dir, rmTemp);
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

/**
 * Spin the real event loop until `done()` holds, under fake timers.
 *
 * The whole point of this file's fake-timer tests: the watcher does REAL fs work
 * inside a poll and inside a flush, and a fixed number of `setImmediate` turns
 * cannot promise a libuv threadpool operation has landed. Waiting on a CONDITION
 * can. `setImmediate` is deliberately not faked, so this still turns while the
 * clock is frozen, and `Date.now` is real, so the bound is a real deadline — a
 * stall fails with a sentence rather than a 20s vitest timeout that reads like a
 * hang.
 */
async function waitUntil(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
}

/**
 * Advance the fake clock by one poll interval and wait until that poll has
 * actually COMPLETED, by watching the watcher's own cycle counter — which is
 * incremented after the scan resolves and its events have armed the debounce.
 */
async function advanceOnePoll(watcher: FileWatcher, pollMs = 60): Promise<void> {
  const before = watcher.cycles;
  await vi.advanceTimersByTimeAsync(pollMs);
  await waitUntil(() => watcher.cycles > before, `poll cycle ${before + 1} to complete`);
}

describe("watchPath", () => {
  it("debounces a burst of writes into a single batch", async () => {
    // R10.2 — the burst is driven by FAKE timers, so the poll and the debounce
    // fire where this test says and not where the machine gets round to it.
    //
    // The old form wrote three times and slept. Debouncing is only exercised
    // when the writes span MORE than one poll interval but less than the
    // debounce window, and real time cannot promise that: descheduled between
    // writes, the first batch flushed before the last write landed, a second
    // batch followed, and `staysQuiet` returned false. Advancing the clock in
    // steps makes "three polls, one flush" the definition of the test rather
    // than a hoped-for consequence of it.
    //
    // Sleeping less, or writing synchronously, would ALSO have gone green — and
    // would have tested nothing: with the writes collapsed into one poll, a
    // watcher with no debouncing at all still emits exactly one batch. That is
    // the trap the sibling fixes in `test-timing-flakes` hit, so the assertion
    // is deliberately "one batch across three separate detections".
    //
    // Only the TIMERS are faked. The watcher does real fs work inside each poll,
    // and faking `setImmediate`/`nextTick` too would stall those promises: the
    // poll never resolves, so it never arms the debounce and never schedules the
    // next cycle.
    //
    // Letting that real I/O finish between simulated ticks is a CONDITION, not a
    // duration. The first version of this test drained ten `setImmediate` turns,
    // which only approximates one: macrotask turns do not wait on the libuv
    // threadpool. It flaked on CI the day after it landed
    // (`file-watcher-settle-is-a-guess`), and in the worst possible shape —
    // `loop` arms the NEXT poll timer only after the previous poll resolves, so
    // outlasting the drain once stalls the chain, and the symptom is an EMPTY
    // batches array rather than a doubled one. Nothing about that reads as
    // "timing" when you find it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const batches: FileChangeBatch[] = [];
    watcher = await watchPath(dir, (b) => batches.push(b), { debounceMs: 150, pollMs: 60 });
    const file = path.join(dir, "note.md");

    // Distinct LENGTHS on purpose: the change signal is `mtimeMs:size`, and
    // three same-length writes inside one mtime tick are indistinguishable from
    // no write at all.
    for (const content of ["a", "bb", "ccc"]) {
      await writeFile(file, content);
      await advanceOnePoll(watcher); // one poll — detects, and RESETS the debounce
    }
    // Three detections so far, and the debounce has been pushed back each time.
    expect(batches).toHaveLength(0);

    // The quiet period elapses and the debounce fires — but `flush()` re-stats
    // every pending path, which is more real fs work, so the batch arrives on a
    // condition too rather than at the end of the advance.
    await vi.advanceTimersByTimeAsync(150);
    await waitUntil(() => batches.length > 0, "the debounce to flush its batch");
    expect(batches).toHaveLength(1);
    expect(batches[0]?.changed).toEqual([file]);
    expect(batches[0]?.removed).toEqual([]);

    // Deliberately NOT asserting "and nothing ever follows". The old test did
    // (`staysQuiet(300)`) and it is not a property of the debouncer: a later poll
    // can see `mtimeMs` change again after the write, because the OS settles file
    // timestamps on its own schedule — observed here on Windows, where a second
    // batch arrived during the quiet window with no further writes. Debouncing
    // means "a burst collapses into one batch", and that is asserted above; the
    // quiet-window claim was always about the filesystem, not this code.
  });

  it("survives a poll whose fs work outlasts any fixed event-loop drain", async () => {
    // The regression guard for `file-watcher-settle-is-a-guess`. A green run of
    // the test above is not evidence on its own — the form it replaced was green
    // locally and on most CI legs, and still failed on one.
    //
    // So reproduce the CI condition with REAL work rather than a mock: a tree big
    // enough that one `snapshot()` is a readdir plus several hundred stats, which
    // comfortably outlasts the ten `setImmediate` turns the old `settle()` drained.
    // Under the old form this stalls the chain and `batches` stays empty; waiting
    // on the cycle counter, it simply takes longer.
    await Promise.all(
      Array.from({ length: 300 }, (_, i) => writeFile(path.join(dir, `bulk-${i}.md`), "x")),
    );

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const batches: FileChangeBatch[] = [];
    watcher = await watchPath(dir, (b) => batches.push(b), { debounceMs: 150, pollMs: 60 });

    // Those 300 are the BASELINE — only what changes after watch start is
    // reported, so exactly one file should come back.
    const file = path.join(dir, "note.md");
    await writeFile(file, "a");
    await advanceOnePoll(watcher);

    await vi.advanceTimersByTimeAsync(150);
    await waitUntil(() => batches.length > 0, "the debounce to flush a batch");
    expect(batches[0]?.changed).toEqual([file]);
  });

  it("reports a deleted file as removed", async () => {
    const file = path.join(dir, "gone.md");
    await writeFile(file, "content");
    const batches: FileChangeBatch[] = [];
    watcher = await watchPath(dir, (b) => batches.push(b), { debounceMs: 150, pollMs: 60 });

    await rm(file);
    const batch = await nextBatch(batches);
    expect(batch.removed).toEqual([file]);
    expect(batch.changed).toEqual([]);
  });

  it("ignores files under a skipped directory (e.g. node_modules)", async () => {
    await mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
    const batches: FileChangeBatch[] = [];
    watcher = await watchPath(dir, (b) => batches.push(b), { debounceMs: 150, pollMs: 60 });

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
    watcher = await watchPath(dir, (b) => batches.push(b), { debounceMs: 150, pollMs: 60 });

    await writeFile(path.join(dir, "image.png"), "binary-ish");
    expect(await staysQuiet(batches)).toBe(true);

    const tracked = path.join(dir, "real.ts");
    await writeFile(tracked, "export const x = 1;");
    const batch = await nextBatch(batches);
    expect(batch.changed).toEqual([tracked]);
  });

  it("close() stops further batches", async () => {
    const batches: FileChangeBatch[] = [];
    const w = await watchPath(dir, (b) => batches.push(b), { debounceMs: 150, pollMs: 60 });
    w.close();

    await writeFile(path.join(dir, "after-close.md"), "content");
    expect(await staysQuiet(batches)).toBe(true);
  });

  describe("nested subdirectories (all platforms)", () => {
    it("picks up a file created in a new subdirectory (dynamic subdir add)", async () => {
      const batches: FileChangeBatch[] = [];
      watcher = await watchPath(dir, (b) => batches.push(b), { debounceMs: 150, pollMs: 60 });

      const subdir = path.join(dir, "sub");
      await mkdir(subdir);
      const nested = path.join(subdir, "deep.md");
      await writeFile(nested, "content");

      const batch = await nextBatch(batches, 6000);
      expect(batch.changed).toEqual([nested]);
    });

    it("picks up changes nested more than one level deep (pre-existing subtree)", async () => {
      const subdir = path.join(dir, "a", "b");
      await mkdir(subdir, { recursive: true });
      const batches: FileChangeBatch[] = [];
      watcher = await watchPath(dir, (b) => batches.push(b), { debounceMs: 150, pollMs: 60 });

      const nested = path.join(subdir, "deep.md");
      await writeFile(nested, "content");

      const batch = await nextBatch(batches, 6000);
      expect(batch.changed).toEqual([nested]);
    });
  });
});
