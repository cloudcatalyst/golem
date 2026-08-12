/**
 * Temp-directory fixtures for the suite.
 *
 * ## Why deleting is the expensive part
 *
 * Node's `rm` defaults to `maxRetries: 0`, which is not survivable on Windows:
 * a tree that was just written is often still held by the indexer, a virus
 * scanner, or a lingering handle when the recursive delete reaches it, and the
 * cleanup fails with `ENOTEMPTY`/`EBUSY`/`EPERM`. That surfaced as intermittent
 * `afterEach` failures in whichever file happened to lose the race under full
 * parallel load (BACKLOG 2026-07-29; the companion 5s-timeout half of that flake
 * was fixed by the 20s `testTimeout` in `vitest.config.ts`, §86c).
 *
 * Retries cost nothing on the happy path — they only engage on exactly the
 * transient error classes Node retries for. But they are not free under load:
 * a delete that loses the race sleeps 50ms and tries again, up to five times,
 * while holding the test open.
 *
 * ## R10.2 — why {@link useTempDirs} exists
 *
 * 82 test files were doing `mkdtemp` in `beforeEach` and a recursive delete in
 * `afterEach` — one create-and-delete cycle per TEST, thousands per run. Under
 * full parallel load those retry-prone deletes are the suite's dominant source
 * of intermittent failure: work that takes well under a second in isolation
 * blew the 20s budget, on a different test each run.
 *
 * {@link useTempDirs} keeps per-test isolation exactly as it was — every test
 * still gets its own freshly-created directory nobody else can see — but moves
 * cleanup to ONE recursive delete per FILE instead of one per test. Same
 * isolation, an order of magnitude fewer deletes.
 *
 * Prefer it over a hand-rolled `beforeEach`/`afterEach` pair in new tests.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";

/**
 * Options for deleting a test's temp tree. Exported because a few tests clean
 * up a directory they created themselves; anything using {@link useTempDirs}
 * gets this applied for it.
 */
export const rmTemp = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 50,
} as const;

/**
 * Per-file temp-directory factory. Call it at the top level of a test file:
 *
 * ```ts
 * const newTempDir = useTempDirs("golem-init");
 * let projectDir: string;
 * beforeEach(async () => {
 *   projectDir = await newTempDir();
 * });
 * // no afterEach — the whole tree goes in one delete when the file finishes
 * ```
 *
 * Registers its own `beforeAll`/`afterAll`, so a file adopting it should DELETE
 * its `afterEach` cleanup rather than keep both.
 *
 * Each returned path is a fresh `mkdtemp` under this file's private root, so
 * tests remain as isolated from each other as they were before — the only thing
 * that changed is when the bytes are reclaimed.
 */
export function useTempDirs(prefix: string): () => Promise<string> {
  let root: string | undefined;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), `${prefix}-`));
  });

  afterAll(async () => {
    // Best-effort: a temp tree that survives a failed cleanup is litter in the
    // OS temp dir, not a broken test run, and throwing here would mask the
    // actual failure that left a handle open.
    if (root !== undefined) await rm(root, rmTemp).catch(() => {});
    root = undefined;
  });

  return async () => {
    if (root === undefined) {
      throw new Error("useTempDirs(): called outside the file's beforeAll — check the import");
    }
    return mkdtemp(path.join(root, "t-"));
  };
}
