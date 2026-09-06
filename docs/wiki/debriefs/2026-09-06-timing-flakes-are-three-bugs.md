---
title: Six Red Tests, Three Different Bugs — And Only Two Were Worth Fixing
type: debrief
tags: [testing, vitest, flakes, ci, determinism, tooling]
sources: [docs/plan/tasks/test-timing-flakes.md, docs/plan/tasks/file-watcher-debounce-determinism.md, src/hooks/web-fetch.ts, src/compression/headroom-adapter.ts, CLAUDE.md]
created: 2026-09-06
updated: 2026-09-06
---

# Six red tests, three different bugs — and only two were worth fixing

`test-timing-flakes` was written as "two suite tests fail on load, not on logic —
margins of 70ms and 100ms". Six tests were red by the time it was picked up, and
the title's diagnosis turned out to cover only two of them.

Pages touched: [[Release Pipeline]] (unchanged) · `CLAUDE.md` § Running the tests.

## The two that were the described bug — fixed

**`web-fetch-budget > still serves when the ingest is skipped`** slept 140ms
against a 90ms budget with a 20ms reserve: a 70ms margin for the machine to eat.
Now `WebFetchHookOptions` takes `clock?: () => number`, defaulted to `Date.now`,
used for the three budget reads. The test *steps* the clock past the deadline.
Production is untouched and the test got faster.

**`headroom-adapter > backs off on unexpected worker death`** slept 400ms for a
worker that dies at 300ms. Now it waits on the observed exit with `expect.poll`.

**That fix was wrong the first time, and the gate's own wording caught it.** The
task requires proving a fixed test still fails when the behaviour regresses. It
did not: asserting `Date.now() >= sc.nextSpawnAt` after `start()` is *vacuously
true* when no backoff is armed, because the deadline is then already in the past
— deleting the backoff entirely left the test green. It now asserts the armed
**delay** (pure state, no clock) as well as the wait.

The lesson generalises past this test: **making a flaky assertion deterministic
and making it weaker look identical from a green run.** Only deliberately
breaking the behaviour tells them apart, which is why that step is in the gate
and not in the "nice to have" column.

## The four that were not — and the reassessment that stopped the work

The instinct was to keep going. Reading them first was worth more:

- **`join-queue` ×2 and `cli-status` R9.22 are 20s vitest TIMEOUTS**, not
  margins. Reproduced verbatim: `Error: Test timed out in 20000ms.` The cap test
  does 16+1 sequential `enqueue` calls, each `#find` + `pending` (both directory
  scans) + `mkdir` + `writeFile` + `rename` — the scans grow with the queue, so
  it is **O(n²) in reads, ~200 fs operations**. That is the implementation
  behaving correctly at a cap of 16 and the test exercising it honestly. **There
  is no defect to fix**, and a first guess — "reuse one queue instance instead of
  17" — was wrong: the constructor does no I/O at all.
- **`file-watcher > debounces a burst of writes`** is a real margin, and the only
  one of the six to have failed in **CI** rather than only on a loaded dev box.
  Tracked as `file-watcher-debounce-determinism`, because the fix needs a design
  choice (a manual scan trigger versus an injected scheduler) that should not be
  made inside an unrelated PR.

Raising `testTimeout` was considered and rejected: it converts a visible flake
into a hidden hang, and 20s is already ~40× what these tests need unloaded.

## What actually pays off: `npm run test:serial`

Three of six needed no code change; they needed a way to run the suite that does
not saturate the machine.

```
npx vitest run --fileParallelism=false
Test Files  262 passed | 1 skipped (263)
      Tests  3437 passed | 2 skipped (3439)
```

Zero failures — on exactly the commit whose parallel runs had failed 2 tests,
then 4, **with a different set each time**. ~7m40s against ~3m45s. Now
`npm run test:serial`, documented in CLAUDE.md, because it was discovered by hand
during a release and would otherwise have stayed folklore.

CLI flag only: R10.1 settled that tuning `vitest.config.ts` for *speed* is a dead
end. This is for *signal*, which is a different question, and the distinction is
worth keeping.

## The diagnostic worth more than any of the fixes

**A load flake fails on ONE matrix leg; an input difference fails identically on
every leg.** Both halves appeared in the same release: `file-watcher` flaked on
`ubuntu / node 22 / shard 4` alone and passed on re-run, while a stale
`ROADMAP.md` failed on all thirty-odd. One is a re-run; the other is a bug. In
CLAUDE.md now, next to the serial script.
