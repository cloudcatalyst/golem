---
task: docs-slider-drift
title: The README still documents the slider R11.1 retired, and shows version 0.1.1
state: queued
owner: agent
size: S
design: No design needed — each item is a fact about README.md against the post-R11.1 build. ADR-0004 retired the slider; R11.4 cleared the leftovers in code and skills but nobody re-read the README.
gate: No user-facing document describes a control that no longer exists, no version string is hand-written where it will go stale, and a check FAILS on the next such drift — so this cannot reopen quietly the way R11.5's wiki Index did.
depends_on: []
touches: [README.md, docs/wiki/WIKI.md, src/cli/wiki.ts, tests/unit/cli]
created: 2026-08-21
updated: 2026-08-21
---

## Found while reviewing the roadmap, 2026-08-21

R11.1 retired the slider and R11.4 swept the strings out of the CLI, the settings
help and the skills. The README was not in either task's `touches`, and it still
teaches the retired model to every first-time reader — this is the *front page* of
a project about to be published (R7.5):

| line | what it says | reality |
|---|---|---|
| `README.md:37-38` | "a byte-faithful forward at slider level ≤ 1" | there is no slider; the dial is `compression` |
| `README.md:45` | "request lifecycle by slider level" | ditto |
| `README.md:74` | panel mock-up shows `Level 1 lossless` | the panel does not render that |
| `README.md:100` | lists `golem slider` as a non-interactive surface | the command is gone |
| `README.md:73` | panel mock-up shows `Golem 0.1.1` | `package.json` is 0.36.0 |

`docs/wiki/WIKI.md:73` also describes `[[Compression Levels]]` as "the 0–3
compression dial; level 0 = passthrough (redaction OFF)" — check that against
ADR-0004, which gave the redaction bypass its own setting precisely so a number
could not turn redaction off.

## The interesting half

Fixing five lines is ten minutes. **The task is the check that stops the sixth.**
R11.5 hit the identical class of bug — the wiki Index drifted 39 debriefs behind
because nothing tied the checklist to a test — and fixed it by teaching
`golem wiki check` one more rule. Do the same here: a retired identifier
(`slider`, `slider.level`, `golem slider`, `level N`) must not appear in
user-facing prose, while staying legal in the places where the wording *is* the
record — dated Decisions Log entries, ADRs, debriefs, and `verification-notes.md`.
That exemption list is the whole design; get it right and the check is useful
rather than a nuisance a future agent disables.

Also decide whether a hand-written version string belongs in a mock-up at all, or
whether the mock-up should carry no version.

## While in there

The README documents no feature shipped after 2026-07-30 — no `golem plugin`
(R8.11, ADR-0005) and no `golem pkg install|remove|upgrade` (R8.14). Add them only
if they are part of the story the front page tells; a complete command list is not
the README's job and this task must not turn into one.

## Out of scope

Rewriting the README's positioning or its measured claims (the ~0%-on-cached-
traffic sentence is deliberate and stays). Auditing every wiki page — the wiki's
historical pages are records. Any code change beyond the check itself.
