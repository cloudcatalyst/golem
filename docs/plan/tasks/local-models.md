---
task: local-models
title: golem devices reports the tier CATALOG, not what Ollama has actually pulled
state: queued
owner: agent
size: S
design: docs/plan/verification-notes.md §89, §100; BACKLOG 2026-07-17 (the judge bug)
gate: A missing model is reported as missing BEFORE a harness or a tool silently falls back to another role.
depends_on: []
touches: [src/inference/, src/cli/]
created: 2026-07-30
updated: 2026-07-30
---

## Goal

Make `golem devices` (and anything that resolves a role to a model) distinguish "this
tier would use model X" from "model X is downloaded and callable".

## Why — this has now cost three times

1. **2026-07-17, the judge bug (BACKLOG).** `coder --refine` reported `rounds: 0` across
   all five LE2 tasks and looked like a prompt/threshold problem. The real cause: the
   judge model (`qwen2.5:14b`) was never pulled, so every judge call failed into a
   silent `catch`. Fixed at the symptom (explicit `RefineStatus`, no silent skips) — not
   at the cause.
2. **§89.** The tools-block A/B had to run `--role drafter` because the tier's
   `classifier` model (`qwen2.5:7b`) is not pulled. Recorded as a caveat on the result.
3. **§100.** Same substitution, same caveat, a second time. Two measurements that
   decided a workstream now both carry it.

On this machine `ollama list` has exactly `bge-m3`, `nomic-embed-text` and
`qwen2.5-coder:7b`. `golem devices` presents the tier's full role map as though those
models were available.

## What to do

- Query Ollama's `/api/tags` and mark each role's model **present** or **not pulled**.
- Surface it in `golem devices` and in `golem local status`.
- Where a caller substitutes a role, make the substitution **explicit in the output**
  rather than a footnote written by hand afterwards (the harness reports already print
  the concrete model — the gap is that nothing warned *before* the run).
- Degrade honestly: not-pulled is a fact to report, never an error path, and never a
  silent zero (the R4.4 lesson).

## Out of scope

Auto-pulling models — that is a large download decided by the user, not the tool.
Changing the tier catalog itself (advisory per Decision 6).
