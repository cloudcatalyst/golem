---
task: long-run-visibility
title: "A long run must show that it is running — `golem verify`, a live status-line segment, and the rule that says stream it"
state: done
owner: agent
size: M
discipline: code
design: USER request 2026-09-02 ("can you bake that monitoring so it's a feature of Golem?"), after a session where six multi-minute gate runs were launched as detached background commands and the app showed an idle session throughout. Builds on three things that already exist — `GUIDANCE_FEATURES` (presence-of-rule is the toggle), `golem statusline` with `statusLine.refreshInterval = 2` (timer-driven, so it re-runs while idle), and the six-check gate that currently exists only as prose in CLAUDE.md and the `/golem:verify` skill.
gate: "`golem verify` runs the gate, emits ONE line-buffered progress line per check with a stable prefix, writes a progress file and a full log whose path it prints FIRST, builds the repo under test before any check that depends on the build, and exits nonzero when ANY check fails (running them all by default; `--fail-fast` opts into stopping) while still reporting suite totals. `golem statusline` renders an in-flight segment from that progress file — appearing within ~2s of a run starting and clearing when it ends — and still never throws, never hangs, and costs one small read. A `long-run-visibility` guidance rule ships in `GUIDANCE_FEATURES`, seeded by default."
depends_on: []
created: 2026-09-02
updated: 2026-09-02
---

## The problem, as observed

Six gate runs in one session, each ~7 minutes, each launched as a detached
background command. Three separate failures came out of that shape:

1. **The session looks idle.** Claude Code's working indicator tracks the active
   turn. A detached process is not the turn, so the app correctly showed nothing
   happening — for forty minutes of real work. The user asked twice whether
   anything was still running.
2. **Every agent re-implements the gate.** It exists as prose, so each run was a
   hand-rolled shell loop. Two of the six were defective: one wrote its log to a
   path copied out of *redacted* output (creating a junk file in the repo root),
   and one regenerated `ROADMAP.md` with a **globally installed `golem` built from
   an older commit**, which silently dropped R14.4's new column and turned the
   drift test red.
3. **Progress is invisible unless someone thinks to wire it up.** Streaming the
   checks as events worked well — but only because it was set up by hand, once,
   after being asked.

## Three parts, in dependency order

### 1. `golem verify` — the gate as a command

The checks CLAUDE.md already names: `tsc --noEmit`, `lint`, `format:check`,
`verify:deps`, `vitest run`, `golem wiki check`.

- **One progress line per check**, line-buffered, with a stable prefix so a
  watcher needs no filter authoring: `golem-verify: tsc ok 12.4s`,
  `golem-verify: vitest FAILED exit=1`. Stdout is the event stream.
- **The log path is printed FIRST**, before any check runs, in a stable location
  under `.golem/` — so a human can `tail -f` it without asking, and no caller has
  to invent a path.
- **Build the repo under test** before any check that depends on the build. This
  is failure (2) above, and it is the whole reason a command beats prose: the
  instruction "rebuild first" was written down and still missed.
- **Exit nonzero on the first failure**, and still print suite totals — the gate is
  judged by exit code (CLAUDE.md), so the exit code must be the honest signal
  while the totals stay readable.
- Coverage rule, borrowed from the harness's own monitor guidance: emit on every
  terminal state, not just success. Silence must never be indistinguishable from
  progress.

### 2. A status-line segment for work in flight

`golem statusline` is the only surface that renders persistently in the app, and
`STATUS_LINE_REFRESH_INTERVAL_SEC = 2` already makes it timer-driven precisely so
external state changes show up on an idle terminal. So a run in flight can be
visible without the session being active at all.

- `golem verify` writes a small progress file; the status line reads it and renders
  something like `⏳ verify 4/6 · vitest 2m10s`, clearing when the run ends.
- **The status line's hard rule still governs**: never throw, never hang. One
  bounded read of a small file, defensive on every error, narrow imports — it runs
  every two seconds on a hot path.
- A stale file (killed run, crashed process) must expire rather than pin a phantom
  run on screen forever.

### 3. The guidance rule that generalises it

A new `GUIDANCE_FEATURES` entry, `long-run-visibility`, seeded by default:
anything expected to take more than ~30s is streamed, not fired and forgotten;
name the log path; never end a turn leaving a multi-minute gap with no signal.

This repo already learned the lesson locally — `.claude/rules/golem-respond-every-turn.md`
is repo-local, not shipped by Golem. Shipping it makes it true for every project.

## Out of scope

- **Golem's own long job.** The KB auto-index is the other multi-minute silent
  run, and it already checkpoints every N files, so the progress data exists.
  Giving it the same treatment is a natural follow-up, not this task.
- Anything that tries to make the harness arm a `Monitor`. Golem cannot invoke its
  client's tools (the same constraint R14.2 records for subagents). Part 3 asks the
  agent; parts 1 and 2 make it cheap and make the run visible even if it does not.
