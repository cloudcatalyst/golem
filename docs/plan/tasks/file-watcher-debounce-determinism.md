---
task: file-watcher-debounce-determinism
title: "The debounce test races the poll loop — a burst of writes can straddle the window and emit two batches"
state: queued
owner: agent
size: S
discipline: code
design: "`src/knowledge/file-watcher.ts` is a polling watcher: a self-scheduling `setTimeout(pollMs)` scan feeds a `setTimeout(debounceMs)` flush. The test (`tests/unit/knowledge/file-watcher.test.ts`, \"debounces a burst of writes into a single batch\") writes three files then asserts ONE batch arrives and that nothing follows within 300ms. Under load the three writes straddle the 150ms debounce, a second scan detects the tail, and a SECOND batch arrives — `staysQuiet(300)` returns false and the failure reads `expected false to be true`. Diagnosed 2026-09-06 while closing `test-timing-flakes`; that task fixed the two sleep-margin flakes and established that the other three are 20s vitest TIMEOUTS, not margins. This one is the only genuine margin left."
gate: "The debounce test cannot fail for want of CPU: the burst and the flush are both driven by the test rather than by wall-clock racing, and the test still fails if debouncing is removed — proven by deliberately breaking it once, the way the two fixes in `test-timing-flakes` were. No production behaviour change: any new seam is defaulted so `watchPath` behaves identically when it is not passed."
depends_on: []
touches: [src/knowledge/file-watcher.ts, tests/unit/knowledge/file-watcher.test.ts]
created: 2026-09-06
updated: 2026-09-06
---

## Why this one is worth fixing and the other three are not

`test-timing-flakes` closed with six tests examined. Three (`join-queue` ×2,
`cli-status` R9.22) are **not test defects**: they overrun the global
`testTimeout: 20_000` on a saturated machine because they are honestly I/O-heavy
— the join-queue cap test alone does ~200 fs operations, O(n²) in directory
scans, at a `MAX_PENDING_PER_CONVERSATION` of 16. Nothing to remove without
weakening what they assert. `npm run test:serial` is the answer there.

This one is different: the assertion **can be made deterministic**, and it is the
only one of the six that has failed in **CI** rather than only on a loaded dev
box (`ubuntu / node 22 / shard 4`, v0.53.0 release run) — so it costs real CI
re-runs, not just local noise.

## The design choice this task exists to make

Two seams would work and they are not equivalent. Pick one deliberately:

1. **A manual scan trigger** — expose something like `scanNow()` on the handle
   `watchPath` returns, so the test drives detection instead of waiting for
   `pollMs`. Smaller, but it only removes half the race: the `debounceMs` flush
   is still a real timer.
2. **An injected scheduler** — accept the `setTimeout`/`clearTimeout` pair (or a
   small clock interface) as an option, defaulted to the globals. Lets the test
   drive both the poll and the flush, which is the only way the assertion stops
   depending on wall time at all. Larger surface, and it has to stay test-only.

Option 2 is what the gate's "cannot fail for want of CPU" actually requires;
option 1 leaves a smaller version of the same bug. Prefer 2 unless it turns out
to be disproportionate, and say which was chosen and why.

## Precedent to follow

Both fixes in `test-timing-flakes` are worked examples, including one that went
wrong in an instructive way:

- `web-fetch-budget` got `clock?: () => number` on its options, defaulted to
  `Date.now` — production untouched, the test steps the clock past the deadline.
- `headroom-adapter` got read-only `nextSpawnAt` / `respawnDelayMs` accessors and
  an `expect.poll` on the observed exit. **The first attempt made the test
  weaker** — asserting only `Date.now() >= nextSpawnAt` after `start()` is
  vacuously true when no backoff is armed — and only the deliberate-break step
  caught it. Do the break-proof before believing the fix.
