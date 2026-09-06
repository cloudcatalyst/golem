---
title: The Task Said Add A Seam; The Test Runner Already Had One
type: debrief
tags: [testing, vitest, fake-timers, determinism, file-watcher]
sources: [docs/plan/tasks/file-watcher-debounce-determinism.md, tests/unit/knowledge/file-watcher.test.ts, src/knowledge/file-watcher.ts]
created: 2026-09-06
updated: 2026-09-06
---

# The task said add a seam; the test runner already had one

`file-watcher-debounce-determinism` was written a few hours before it was picked
up, by the same session, and it recommended injecting a scheduler into
`src/knowledge/file-watcher.ts` — calling a manual scan trigger "a smaller
version of the same bug".

**Neither was needed.** `vi.useFakeTimers()` drives `setTimeout`/`clearTimeout`
already, so the fix is entirely in the test and production code is untouched.
Worth recording precisely because the task was confident and wrong: a task doc is
a hypothesis about the fix, not the fix.

Pages touched: none — this is a test-only change. Related: [[Release Pipeline]]
(unchanged).

## The catch that made the first attempt fail

Faking everything gives zero batches. The watcher does **real fs work** inside
each poll, and faking `setImmediate`/`nextTick` too stalls those promises: the
poll never resolves, so it never arms the debounce and never schedules the next
cycle.

```ts
vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };
```

Fake the timers, leave the microtask queue alone, and drain it between simulated
ticks. Two more details that are easy to get wrong:

- **Distinct write LENGTHS** (`a`, `bb`, `ccc`). The change signal is
  `mtimeMs:size`; three same-length writes inside one mtime tick look exactly
  like no write at all.
- **Advance in poll-sized steps.** Debouncing is only exercised when the burst
  spans more than one poll interval but less than the debounce window. Collapse
  the writes into a single poll — which is what "just use `writeFileSync`" would
  do — and a watcher with **no debouncing whatsoever** still emits exactly one
  batch. Green, and testing nothing.

## An assertion removed, which made the test stronger

The old test ended with `staysQuiet(300)`: no batch ever follows. That was the
assertion that flaked, and it was **never a property of the debouncer**. A later
poll can legitimately see `mtimeMs` change again with no further writes, because
the OS settles file timestamps on its own schedule — reproduced here on Windows,
where a second batch arrived in the quiet window.

So the test now asserts what debouncing means: three separate detections collapse
into exactly one batch. Fewer assertions, more claim.

## The pattern across all three fixes today

Three timing tests were made deterministic this session, and each needed a
different tool — which is the point:

| test | the tool |
|---|---|
| `web-fetch-budget` | an injected `clock` on the options, defaulted to `Date.now` |
| `headroom-adapter` | `expect.poll` on the observed event + read-only state accessors |
| `file-watcher` | `vi.useFakeTimers`, no source change at all |

Reaching for a source seam first would have been wrong twice out of three.

And every one of them got the same last step: **break the behaviour deliberately
and watch the test fail.** It earned its place — the `headroom-adapter` fix was
vacuous on the first attempt and only the break showed it.
