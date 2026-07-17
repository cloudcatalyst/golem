---
title: PRE-R6 loose-ends closeout
type: debrief
tags: [pre-r6, loose-ends, coder, proxy, auto-resume, permissions]
sources: [docs/plan/PRE_R6_BATCH.md, docs/plan/ROADMAP.md, docs/plan/proposals/auto-resume-on-limit.md]
created: 2026-07-17
updated: 2026-07-17
---

# PRE-R6 loose-ends closeout

Cleared the carried-over loose-ends ledger before R6 is revisited, plus one new
feature the dogfooding surfaced (auto-resume). Suite 1040 → **1055 green**;
`tsc`/`biome` clean throughout.

## What landed

- **LE1 (Decision 33)** — already ACCEPTED 2026-07-17 (verification-notes §69c).
- **LE5 (incl. LE5c)** — already shipped in `deccfc5`: `FileVectorDriver.upsert`
  clears the collection when the incoming vector dimension differs from a
  non-zero `col.dim`, and `auto-index.ts` `fullIndex` `rm`s the dir on an
  embedder change (+2 unit tests). The batch doc had stale "fix planned" text;
  reconciled.
- **LE3** — grounding into `golem task run`: extracted the shared
  `gatherGrounding` (exported from the MCP server) and a testable
  `src/cli/task-grounding.ts`; locally-serviced tasks now ground like `coder`.
  +3 tests.
- **LE2** — fair grounded/refined coder measurement — see
  [[LE2 — grounded-refined coder quality]]. Headline: grounding improves
  *revise-quality*, not the verdict count; `refine` fired 0/5 rounds.
- **LE2 follow-up (refine fix)** — root-caused the 0-rounds: the judge model
  (`qwen2.5:14b`) isn't pulled, the service's step-down tries only other
  (also-unpulled) *judge* models, and a silent `catch` in `refineDraft` reported
  `rounds:0` — while the `coder` tool falsely printed "nothing worth revising".
  Fixed: explicit `RefineStatus` (`revised|clean|judge-unavailable|unparseable|
  empty-revision|error`) so a skip is never silent, a **judge→drafter
  self-review fallback** (the drafter is pulled and — verified live — critiques
  well), and a truthful `coder` note. E2E against live Ollama: a flawed draft is
  now critiqued (high severity) and revised. +2 tests (8 total); suite 1057.
- **LE4** — CI confirmed green on `deccfc5`; R2.6 re-scoped as
  unblocks-with-R6.1, R1.6 still hardware-blocked, R5.5 explicitly deferred.

## New feature (dogfooding-driven): auto-resume on limit
The proxy is the only component that sees an upstream usage-limit response, so
**Phase 1** now detects a 429, logs the full signal to
`.golem/state/limit-hits.jsonl` (to validate the unknown subscription
session/weekly-limit shape), and captures a durable resume task gated to the
reset time. Observe-only, **ON by default** (safe — no spawning). **Phase 2**
(auto-spawn at reset) is deferred behind ADR-0002. Design:
`docs/plan/proposals/auto-resume-on-limit.md`; durable task `20a9f9ae`.

## Corrections worth recording
- **`mcp__golem__*` is a valid anchored allow glob** (live Claude Code docs,
  "MCP" section) — equivalent to the bare `mcp__golem`. An earlier claim that it
  "never matches" was wrong. Standardized init + committed settings on the bare
  form. The real cause of committed-settings prompts is the one-time
  **workspace-trust** gate, not the syntax.
- **Permission prompts on `npx …`/`golem task add`** were caused by shell
  metacharacters (`&&`, `|`, `;`, `<`, `>`) in the command/args, which route a
  compound command through per-segment approval — not an allowlist gap.

## Process
Added a **Batch close-out** section to `CLAUDE.md` (build+verify → local deploy
→ tidy planning docs → commit/PR) so future batches restart the running services
and update the docs as a matter of course. See [[Dogfooding Golem]].
