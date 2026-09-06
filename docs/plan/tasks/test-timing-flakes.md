---
task: test-timing-flakes
title: "Two suite tests fail on load, not on logic — FIXED; four more exist and are NOT the same bug"
state: done
owner: agent
size: S
design: Found while gating R14.2 (2026-09-02). Adjacent to `R13.17-test-wall-time`, which changes how the suite is parallelised and therefore changes the load these two measure themselves against.
gate: "Neither test can fail for want of CPU: each either drives time deterministically (fake timers or an injected clock) or asserts on an observed event rather than a wall-clock deadline. Both still fail if the behaviour they cover regresses — proven by breaking that behaviour deliberately once."
depends_on: []
touches: [tests/integration/headroom-adapter.test.ts, tests/integration/hooks/web-fetch-budget.test.ts, src/hooks/web-fetch.ts, src/compression/headroom-adapter.ts]
created: 2026-09-02
updated: 2026-09-06
---

## The two

1. **`tests/integration/headroom-adapter.test.ts`** — "backs off on unexpected
   worker death and does not respawn immediately (R8.30)". The fake worker dies
   at 300ms; the test sleeps 400ms and asserts `isRunning()` is false. Under load
   the exit handler has not run inside that 100ms margin, and it reads `true`.

2. **`tests/integration/hooks/web-fetch-budget.test.ts`** — "still serves when
   the ingest is skipped for want of budget, and caches the page". It sets
   `budgetMs: 90` with `serveReserveMs: 20` and a fetch that sleeps 140ms, so the
   margin before the reserve check is **70ms**. Late, the hook bails before
   emitting the deny-that-serves and `permissionDecision` is `undefined`.

Both passed 19/19 in isolation and 0 failed on a full re-run of the same commit,
so they are load-dependent, not regressions — and they were *rightly* scaled down
to milliseconds rather than sleeping past a real 4s reserve. The problem is the
scale, not the intent.

## Why it matters more than two red lines

A gate judged by exit code (CLAUDE.md, while CI is billing-blocked) cannot
distinguish "flaky" from "broken" — the merge stops either way, and the honest
response is a re-run, which trains the reader to re-run rather than to look. The
suite grows every batch, so the margins only get tighter: R14.2 alone added ~23
tests and both failures appeared on that run.

## A third one, found 2026-09-06

The title says two; there are at least three. During the v0.53.0 release CI:

```
tests/unit/knowledge/file-watcher.test.ts > watchPath > debounces a burst of writes into a single batch
AssertionError: expected false to be true
```

`test / ubuntu-latest / node 22 / shard 4` only — green on every other leg of the
same run, and green on re-run with no change. A debounce window racing a loaded
runner, the same shape as the other two.

Two more flaked locally under full-suite load and passed in isolation, so they
belong in the same sweep: `tests/integration/cli-status.test.ts` ("reads the CA
trust from settings.local.json (R9.22)", 20054ms) and
`tests/unit/session/join-queue.test.ts` (two `FileJoinQueue` cases, 20949ms).
Both took ~20s, which is a timeout, not a margin.

A fourth, seen 2026-09-06 on a full local run:

```
tests/integration/hooks/web-fetch-budget.test.ts > web-fetch-pre budget (R9.21)
  > still serves when the ingest is skipped for want of budget, and caches the page
AssertionError: expected undefined to be 'deny'
```

This one is worth singling out because **it does not look like a timing test** —
the assertion is on a hook decision, not a duration, so it reads as a real
regression. It passed in isolation immediately afterwards. The test budgets
itself against a timeout (R9.21), so a saturated machine makes the budget
decision it asserts on never arrive.

### The measurement that settles it (2026-09-06)

Two consecutive full-parallelism runs of the SAME commit failed different sets —
2 tests, then 4, with `headroom-adapter` passing in the first at 3438ms and
failing in the second, and `web-fetch-budget` failing on a *different* test each
time. Then, sequentially:

```
npx vitest run --fileParallelism=false
Test Files  262 passed | 1 skipped (263)
      Tests  3437 passed | 2 skipped (3439)
   Duration  457.38s
```

**Zero failures.** So every one of the six is parallelism-induced, and none is a
logic defect. `--fileParallelism=false` costs ~7m37s against ~3m45s and is the
cheapest trustworthy answer when a local gate is flaking — CLI only, since R10.1
settled that tuning `vitest.config.ts` for *speed* is a dead end (this is for
*signal*, which is a different question).

**Diagnostic worth keeping:** a load flake fails on ONE matrix leg and passes on
the rest; a real input difference fails identically on every leg. That single
distinction is what separated this from the ROADMAP staleness bug in the same
release (verification-notes §156 addendum).


## OUTCOME (2026-09-06) — the two are fixed and proven; four others are different bugs

### Fixed, each proven by deliberately breaking the behaviour it covers

1. **`web-fetch-budget > still serves when the ingest is skipped`.** Added
   `clock?: () => number` to `WebFetchHookOptions` (defaults to `Date.now`, so
   production is unchanged) and used it for the three budget reads. The test now
   *steps* the clock past the deadline instead of sleeping 140ms against a 90ms
   budget. Break-proof: forcing the ingest branch on makes the test fail.

2. **`headroom-adapter > backs off on unexpected worker death`.** Waits for the
   OBSERVED exit via `expect.poll` instead of sleeping 400ms, and asserts against
   two new read-only accessors, `nextSpawnAt` and `respawnDelayMs`.

   **The first attempt at this made the test WEAKER and the break-proof caught
   it.** Asserting only `Date.now() >= nextSpawnAt` after `start()` is *vacuously
   true* when no backoff is armed, because the deadline is then already in the
   past — removing the backoff entirely still passed. It now asserts the armed
   *delay* (pure state, no clock) as well as the wait. **Do not drop that second
   assertion.**

### The other four are NOT this bug, and the title used to imply they were

Found while fixing the above. **Three of the four are 20s vitest TIMEOUTS on
I/O-heavy tests, not millisecond margins** — a different bug wearing the same
red. Only `file-watcher` is a margin, and it is a polling-loop margin rather than
a sleep:

- **`join-queue` ×2** (`caps how many messages`, `EXPIRES a message`) —
  **REPRODUCED 2026-09-06** on a full parallel run, and it is not what it looked
  like:

  ```
  FAIL tests/unit/session/join-queue.test.ts > FileJoinQueue > caps how many messages one conversation may hold
  Error: Test timed out in 20000ms.
  ```

  A **vitest timeout**, not a failed assertion. The test performs
  `MAX_PENDING_PER_CONVERSATION` (16) + 1 sequential `enqueue` calls, each
  constructing a fresh `FileJoinQueue` and doing a `readdir` + `writeFile` +
  `rename` round-trip — 17 serial fs round-trips that overrun 20s on a saturated
  machine. These tests already use an injected clock and a fresh `mkdtemp`, which
  is why the "margin" story never fit.

  **A first guess at the fix was wrong and is recorded so nobody repeats it:**
  "reuse one queue instance instead of 17" saves nothing — the constructor does
  no I/O at all, only field assignment. The cost is per-`enqueue`, and each one
  does `#find` + `pending` (both directory scans) + `mkdir` + `writeFile` +
  `rename`. The scans grow with the queue, so the loop is **O(n²) in file reads**:
  ~200 fs operations for 16 messages. That is the implementation behaving as
  designed at a cap of 16, and the test exercising it honestly — there is no test
  defect here to fix.
- **`file-watcher > debounces a burst of writes`** — a real polling loop
  (`pollMs`/`debounceMs` with `setTimeout`). The three writes can straddle the
  150ms debounce window, so a SECOND batch arrives and `staysQuiet(300)` returns
  false. Making this deterministic needs a source-side seam (a manually triggered
  scan, or an injected scheduler), not a test tweak.
- **`cli-status > reads the CA trust from settings.local.json (R9.22)`** — failed
  at **20054ms**: the same 20s vitest timeout, in a test that runs a real
  `golemInit`. So this and the two above are ONE class — I/O-heavy tests
  overrunning the default `testTimeout` under load — and only `file-watcher` and
  the two now fixed were ever margin bugs.

### The diagnostic that is worth more than any of the fixes

**A load flake fails on ONE matrix leg; an input difference fails identically on
every leg.** Both halves were observed in the same release: `file-watcher` failed
on `ubuntu / node 22 / shard 4` alone and passed on re-run, while a stale
`ROADMAP.md` failed on all of them.

And when a local gate is flaking, `npx vitest run --fileParallelism=false` is the
cheapest trustworthy answer — 3437 passed, zero failures, ~7m37s against ~3m45s.
CLI only: R10.1 settled that tuning `vitest.config.ts` for *speed* is a dead end;
this is for *signal*, which is a different question.
