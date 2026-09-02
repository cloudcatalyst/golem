---
title: Long-Run Visibility — The Gate As A Command, And The One Surface That Ticks While Idle
type: debrief
tags: [cli, statusline, observability, verification, testing, windows, guidance]
sources: [docs/plan/tasks/long-run-visibility.md, src/cli/verify.ts, src/cli/verify-progress.ts, src/hooks/settings-extras.ts, docs/plan/verification-notes.md]
created: 2026-09-02
updated: 2026-09-02
---

# Long-run visibility — what shipped, and the three failures that specified it

**The report.** During the R14 landing session the user asked twice whether
anything was still running, then said plainly: *"I don't see the Claude Code app
showing that it's working on anything."* Six gate runs of ~7 minutes each had
been launched as detached background commands.

**The diagnosis is not a bug.** The harness shows a working indicator only while
a turn is active. A detached process is not the turn, so the app was reporting
the truth — the session really was idle while a separate process worked. What was
missing was any surface carrying the other fact.

## Three failures, each of which specified a part

1. **The session looks idle.** Forty minutes of real work, no signal.
2. **Every agent re-implements the gate.** It existed only as prose in CLAUDE.md
   and the `/golem:verify` skill, so each run was a fresh shell loop. Two of six
   were defective: one wrote its log to a path copied out of *redacted* output,
   creating a junk file in the repo root; one regenerated `ROADMAP.md` with a
   globally installed `golem` built from an older commit, silently dropping
   R14.4's new `discipline` column until the drift test caught it.
3. **Progress is invisible unless somebody wires it up by hand.** Streaming the
   checks worked well — but only after being asked, and two hand-rolled watchers
   died silently in the process (one pointed at the wrong directory, one broke on
   a shell comparison and exited 0 with no output).

Failure 2 is the interesting one. *"Rebuild first"* was written down, in the
close-out checklist, and still missed — twice, by an agent that had read it. That
is the signature of an instruction that belongs in code rather than prose.

## What shipped

**`golem verify`** runs the seven checks — build first,
then typecheck, lint, format:check, verify:deps, test, wiki — and:

- prints its **log path first**, before any work, so a watcher attaching late
  still finds it, under `.golem/state/` so a run cannot litter the repo;
- emits **one line per check** with the stable prefix `golem-verify:`, so stdout
  IS the event stream and a watcher needs no knowledge of internals;
- **builds the repo under test** before any check that reads `dist/` — and keeps
  the build even under `--only wiki`, so a narrowed run cannot check a stale one;
- runs **all** checks by default, exiting nonzero if any failed. Stopping at the
  first is what let a red `vitest` hide whether the wiki was clean; `--fail-fast`
  opts in.

**A status-line segment** — `⏳ verify 4/7 · test 2m01s`. This is the part that
answers the original complaint, and it works only because of a decision made
earlier for a different reason: `golem init` already sets Claude Code's
`statusLine.refreshInterval` to **2 seconds** (verified 2026-07-24), precisely so
that state changed outside the conversation would appear on an idle terminal. So
the segment ticks with the session idle. It is the only surface that does.

**A guidance rule**, `long-run-visibility`, seeded by default in
`GUIDANCE_FEATURES`: use `golem verify`, stream anything over ~30s, name the log
path. This repo had already learned the lesson locally in
`.claude/rules/golem-respond-every-turn.md`, which Golem does not ship — so the
rule generalises it.

## Two Windows facts, both found by running it

**`spawn EINVAL`.** Spawning `npm.cmd` with `shell: false` fails outright since
Node's CVE-2024-27980 change. Both usual escapes are wrong here: `shell: true`
undoes CLAUDE.md's argument-array rule, and hard-coding
`node_modules/.bin` re-implements npm's resolution. The fix runs **npm's own
`npm-cli.js` under `process.execPath`** — same npm as this Node, no shell on any
platform, array intact.

**`spawn` can throw synchronously**, and the `'error'` listener never sees it.
Unhandled, that killed the very first run after two progress lines and named no
check at all. It is now caught and recorded as exit 127, so a spawn failure is a
failed *check* rather than a dead run.

## The lesson worth keeping

The staleness rule in `verify-progress.ts` is small and load-bearing: a run
writes a heartbeat every 5s, and a record older than 30s renders as **nothing**.
A killed session leaves the file behind, and a status line that trusted it would
pin a phantom "verify running" on screen forever. Confidently wrong is worse than
silent — the same principle as the set-vs-ran gap in [[Compression Levels]], one
surface further out.

Verified by the feature on itself: **ALL GREEN (7 checks, 2m37s)**, `Tests 3390
passed | 2 skipped (3392)`, exit 0.
