---
title: A Drain Is Not a Condition — The Debounce Flake That Survived Its Own Fix
type: debrief
tags: [testing, vitest, flakes, ci, determinism, file-watcher, fake-timers, libuv]
sources: [docs/plan/tasks/file-watcher-settle-is-a-guess.md, docs/plan/tasks/file-watcher-debounce-determinism.md, src/knowledge/file-watcher.ts, tests/unit/knowledge/file-watcher.test.ts, docs/wiki/debriefs/2026-09-06-file-watcher-fake-timers.md]
created: 2026-09-06
updated: 2026-09-06
---

# A drain is not a condition

`file-watcher-debounce-determinism` closed on 2026-09-06 having replaced real
sleeps with fake timers, and its own CI run was green. **The very next PR hit the
same test failing on CI**, on `windows / node 24 / shard 4` alone:

```
watchPath > debounces a burst of writes into a single batch
AssertionError: expected [] to have a length of 1 but got +0
```

Pages touched: [[Change Ledger]] · `CLAUDE.md` § Running the tests (unchanged —
its one-leg diagnostic is what identified this correctly).

## The diagnosis, and why the symptom pointed the wrong way

The fixed test faked only `setTimeout`/`clearTimeout` — correct, because faking
`setImmediate` stalls the watcher's real fs promises. To let that real I/O finish
between simulated ticks it drained ten `setImmediate` turns:

```ts
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };
```

**Ten macrotask turns is not a guarantee that a libuv threadpool operation has
completed.** It is a guess that usually holds. And `watchPath` chains its own
polling:

```
loop() → await poll() → await snapshot(root)      // real readdir + stat
       → arms the debounce
       → and only THEN arms the next poll timer
```

So the failure is not "one assertion raced". Outlast the drain once and the
*chain stops*: the debounce is never re-armed, the next poll is never scheduled,
the remaining writes are never detected, and the final clock advance flushes
nothing. The array is **empty**, not doubled.

That is what made it hard to read. A debounce test failing with *too few* batches
looks like a broken debounce, or a missed write, or an fs-granularity problem —
`0` is the shape you would expect from almost any cause except a timing one.

## The proof that mattered

The task demanded two, because the previous fix in this area shipped wrong having
done only one. Both were run, and the first is the interesting one:

**1. The old form must fail the new test.** Restoring the ten-turn drain:

- `debounces a burst of writes into a single batch` — **passes, in 21ms**
- `survives a poll whose fs work outlasts any fixed event-loop drain` —
  **fails**, `timed out waiting for the debounce to flush a batch`

That is the whole finding in two lines. The old test passes *quickly and
happily* under the exact condition that breaks it in CI, which is precisely why
this shipped as fixed and flaked the next day. A green run of the original test
was never evidence of anything.

**2. Removing the debounce must fail.** `onEvent` flushing immediately gives
`expected [ …, … ] to have a length of +0 but got 2`. The fix did not make the
assertion weaker.

## The fix

`FileWatcher` gains `readonly cycles: number`, incremented after a poll's scan
resolves and its events have armed the debounce. The test's wait becomes a
**condition** rather than a duration:

```ts
async function advanceOnePoll(watcher: FileWatcher, pollMs = 60) {
  const before = watcher.cycles;
  await vi.advanceTimersByTimeAsync(pollMs);
  await waitUntil(() => watcher.cycles > before, `poll cycle ${before + 1} to complete`);
}
```

`waitUntil` spins real `setImmediate` turns against a real `Date.now` deadline —
so a genuine stall fails with a sentence rather than a 20s vitest timeout that
reads like a hang. The flush is waited on the same way, because `flush()` re-stats
every pending path and that is more real fs work.

Nothing about polling, debouncing or batching changed. The counter is
observability, and it earns its place: a test driving this watcher on fake timers
has no other way to know the poll's real I/O has landed.

## The regression guard uses real work, not a mock

`survives a poll whose fs work outlasts any fixed event-loop drain` writes 300
files first, so one `snapshot()` is a readdir plus several hundred stats. That
reproduces the CI condition with genuine I/O rather than a mocked delay — and it
is what fails under the old drain. Without it, the next person to "simplify" the
wait back to a fixed count gets a green suite.

## Lessons

1. **A fixed wait standing in for a condition is a bug with a long fuse.** The
   previous debrief said exactly this about sleeps, then shipped a drain, which is
   the same mistake in faster clothing. The question to ask is not "is this long
   enough" but "what am I actually waiting for, and can I observe it".
2. **`setImmediate` turns do not wait on the libuv threadpool.** Faking timers
   makes real fs work *more* exposed, not less, because the clock no longer
   advances while it runs.
3. **When a stall can break a self-scheduling chain, the symptom is silence.**
   Look at what arms the next iteration: here the next poll timer was set only
   after the previous poll resolved, which turns one slow scan into a permanent
   stop.
4. **CLAUDE.md's one-leg diagnostic worked.** One matrix leg failing and passing
   on re-run said "load flake" correctly — but "flake" is a description of the
   trigger, not a reason to stop. The mechanism underneath was a real defect in
   the test, and it was findable.
