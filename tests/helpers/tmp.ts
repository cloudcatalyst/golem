/**
 * Shared options for deleting a test's temp tree.
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
 * transient error classes Node retries for.
 */
export const rmTemp = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 50,
} as const;
