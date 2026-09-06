---
task: test-timing-flakes
title: "Two suite tests fail on load, not on logic — margins of 70ms and 100ms"
state: queued
owner: agent
size: S
design: Found while gating R14.2 (2026-09-02). Adjacent to `R13.17-test-wall-time`, which changes how the suite is parallelised and therefore changes the load these two measure themselves against.
gate: "Neither test can fail for want of CPU: each either drives time deterministically (fake timers or an injected clock) or asserts on an observed event rather than a wall-clock deadline. Both still fail if the behaviour they cover regresses — proven by breaking that behaviour deliberately once."
depends_on: []
touches: [tests/integration/headroom-adapter.test.ts, tests/integration/hooks/web-fetch-budget.test.ts]
created: 2026-09-02
updated: 2026-09-02
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

**Diagnostic worth keeping:** a load flake fails on ONE matrix leg and passes on
the rest; a real input difference fails identically on every leg. That single
distinction is what separated this from the ROADMAP staleness bug in the same
release (verification-notes §156 addendum).
