---
task: file-watcher-settle-is-a-guess
title: "The debounce test still flakes — `settle()` counts event-loop turns as a proxy for fs I/O finishing, and one missed poll stalls the whole chain"
state: done
owner: agent
size: S
discipline: code
design: "The fix this supersedes is `docs/plan/tasks/file-watcher-debounce-determinism.md` (done 2026-09-06) and its debrief `docs/wiki/debriefs/2026-09-06-file-watcher-fake-timers.md`. The sibling lesson — that `expect.poll` + state accessors is the right tool when a fixed wait is standing in for a condition — is `docs/wiki/debriefs/2026-09-06-timing-flakes-are-three-bugs.md`. Code: `src/knowledge/file-watcher.ts`, test `tests/unit/knowledge/file-watcher.test.ts`."
gate: "The test must not depend on a fixed number of event-loop turns being enough for real fs I/O. Prove it the way the last two timing fixes were proven: (1) removing the debounce from `watchPath` must still fail the test — the fix must not make the assertion weaker; (2) the test must survive artificial delay in the poll's fs work, which is the CI condition it fails under. A green run alone is not evidence, because the current form is green locally and on most legs."
depends_on: []
touches: [src/knowledge/file-watcher.ts, tests/unit/knowledge/file-watcher.test.ts]
created: 2026-09-06
updated: 2026-09-06T13:40:16.135Z
---

## What happened

`file-watcher-debounce-determinism` was closed 2026-09-06 having replaced real
sleeps with fake timers. Its own CI run was green. **The very next PR (#175) hit
the same test failing on CI**, on one leg only:

```
tests/unit/knowledge/file-watcher.test.ts > watchPath > debounces a burst of writes into a single batch
AssertionError: expected [] to have a length of 1 but got +0
   test / windows-latest / node 24 / shard 4
```

Every ubuntu shard and `windows / node 22` passed, and it passed on re-run — the
one-leg-plus-passes-on-re-run signature CLAUDE.md calls a load flake. So the fake
timers narrowed the window; they did not close it. The change under test in #175
was the config cascade, which touches nothing the watcher reads.

## The mechanism, which is precise and worth writing down

`watchPath` chains its own polling:

```
loop()  →  await poll()  →  await snapshot(root)     // REAL readdir + stat
        →  arms debounce: setTimeout(flush, debounceMs)
        →  arms next poll: setTimeout(loop, pollMs)   // only AFTER poll resolves
```

The test fakes only `setTimeout`/`clearTimeout` — correctly, because faking
`setImmediate` stalls the watcher's real fs promises. To let that real I/O finish
between simulated ticks it drains ten `setImmediate` turns:

```ts
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };
```

**Ten macrotask turns is not a guarantee that a libuv threadpool operation has
completed.** It is a guess that usually holds. When it does not hold, the damage
is not one missed assertion — it is the whole chain, because the *next* poll
timer is armed only after the previous poll resolves. One slow `snapshot()` and:

1. the debounce is never (re-)armed,
2. no further poll is ever scheduled, so the remaining writes are never detected,
3. `advanceTimersByTimeAsync(150)` finds no debounce timer and flushes nothing,
4. `batches` stays `[]` — exactly what CI reported.

That is the same class of error the fix's own debrief warned about: a fixed wait
standing in for a condition is a hoped-for consequence, not a definition.

## What to build

Replace the turn-count drain with an **observable completion signal**, so the
test advances only once the poll it just triggered has actually finished.

The straightforward shape: have `watchPath` expose a monotonically increasing
poll-cycle count (or resolve a per-cycle promise) on the handle it already
returns, and have the test wait for that count to increment before advancing
again. `vi.waitFor` / `expect.poll` over that accessor is the tool the sibling
task already established for this.

Keep faking only `setTimeout`/`clearTimeout`. The reason is recorded in the test
and still holds.

## The two proofs, not one

The last two timing fixes both taught the same lesson, and one of them **shipped
wrong first time because only the first proof was done**:

1. **Break the behaviour.** Remove the debounce from `watchPath`; the test must
   fail. This is what stops a "fix" that merely weakened the assertion.
2. **Break the timing.** Make the poll's fs work artificially slow — longer than
   ten event-loop turns — and the test must still pass. This is the actual CI
   condition, and the current form fails it. Without this proof there is no
   evidence the flake is gone rather than re-narrowed; the previous fix was green
   on its own CI run and flaked the next day.

## Out of scope

- **Changing the watcher's production behaviour.** A poll-cycle counter is
  observability for the test; the polling, debouncing and re-stat semantics stay
  exactly as they are. If this task starts editing `flush()` or the debounce
  window, it has gone wrong.
- Raising `testTimeout`. Already rejected in `test-timing-flakes`: it turns a
  visible flake into a hidden hang.
- The other tests in this file, unless the same accessor makes them simpler for
  free.

## Outcome

shipped — FileWatcher.cycles; test waits on a condition; both proofs run
