---
task: P3a
title: CLAUDE.md compaction actuator — the write half of R6.4's leanness check
state: queued
owner: agent
size: M
design: docs/plan/proposals/r8-context-economy.md (Workstream P, P3a); verification-notes §87
gate: Report the saving AND its cost together (Decision 52's rule). Code, URLs and paths byte-preserved; the human reviews the rewrite before it lands.
depends_on: []
touches: [src/cli/, src/prompt/]
created: 2026-07-30
updated: 2026-07-30
---

## Goal

`CLAUDE.md` is sent on every request in every session. R6.4 already ships a **leanness
check**; this is the **actuator** — a reviewed rewrite that makes the file shorter
without losing what it instructs.

## Provenance and the honest framing

Caveman ships `/caveman-compress <file>`, which rewrites `CLAUDE.md` into caveman-speak
and claims ~46% input tokens saved every session after, with "code, URLs, paths
byte-preserved". §87 is decisive that Caveman's *speech skill* is not wrappable — its
own README puts input tokens saved at **0%** and admits ~1–1.5k input tokens **added**
per turn — but this component is different, and **Golem has no equivalent**. It passes
Decision 53's four-criterion admission bar.

Two routes, and choosing between them is part of the task:

1. **Tier 2** — install and invoke theirs, pinned, with consent (depends on R8.14).
2. **Tier 3b** — Golem's own rewrite via the local model. `src/prompt/` already does
   local, inspectable, shown-never-sent rewriting for R5.5, so the seam exists; cite
   the source and copy nothing.

Route 2 fits the existing seams better and avoids a dependency; route 1 is less work
and tracks an upstream. Measure before choosing.

## Hard constraints

- **The human reviews the rewrite.** This edits the file that instructs every future
  session; an unreviewed automated rewrite of the instructions is the highest-leverage
  way to break the project quietly.
- Byte-preserve code, commands, paths, URLs and identifiers. Non-negotiable — the same
  rule the brevity directive already states for prose.
- Report saving **and** cost in one view (Decision 52). A compressed `CLAUDE.md` the
  model follows less reliably is a loss, so say what was measured, not just what was
  saved.
- `hasExistingBrevityDirective` (`src/pipeline/brevity.ts`) stands down on any
  `/caveman/i` mention — don't create a path where Golem's own output collides with
  itself.

## Out of scope

Wrapping the Caveman speech skill (settled: §87, Decision 52, Decision 53). Rewriting
the wiki or the spec. Anything that edits `CLAUDE.md` without review.
