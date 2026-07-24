---
title: Wiki knowledge-loop batch (T1–T7 + init guidance)
type: synthesis
tags: [wiki, knowledge, redaction, telemetry, retrospective]
sources: [docs/plan/next_batch.md, docs/plan/ROADMAP.md, docs/wiki/debriefs/2026-07-10-T1.md, docs/wiki/debriefs/2026-07-11-T3.md]
created: 2026-07-11
updated: 2026-07-11
---

# Wiki knowledge-loop batch (T1–T7 + init guidance)

The batch specified in `docs/plan/next_batch.md` (now retired) and its follow-up
`golem init` guidance change. Eight landed pieces of work, 2026-07-10 → 07-11,
taking the test baseline from 70 files / 666 tests to **77 / 728**. This page
ties them together and records what carries forward; the per-task detail lives in
each debrief and is not restated here.

## The through-line: the knowledge loop closed end to end

The batch's real subject was making [[Wiki-First Knowledge]] and the
[[Distillation Pipeline]] *operational* rather than aspirational. Read as a
pipeline, the tasks form one loop:

- **Capture** — `golem note` (debriefs/2026-07-10-T4.md) and the existing
  WebFetch/`ingest` capture paths put raw, searchable-but-disconnected content
  into zone 1.
- **Distill** — the summarizer-backed engine (debriefs/2026-07-11-T3.md) turns a
  raw webcache page into a wiki-shaped, model-authored **source-note draft**,
  idempotent by URL, with invented wikilinks dropped rather than trusted.
- **Retrieve** — graph-first `search` (debriefs/2026-07-11-T5.md) tries the
  title/wikilink graph *ahead* of vector search, so a promoted page ranks above
  any raw chunk.
- **Stay fresh** — the file watcher (debriefs/2026-07-11-T6.md, implementing
  ADR-0001 (docs/decisions/ADR-0001-file-watcher.md)) keeps the derived index current as pages change.
- **Promote (by habit)** — the `golem init` guidance change
  (debriefs/2026-07-11-golem-init-guidance.md) bakes "a capture has no place in
  the graph until it's a wiki page" into every project's `CLAUDE.local.md`, so
  the loop's one human-gated step (promotion) becomes a default practice.

Two supporting tasks sit beside the loop: the wiki **skills** that expose it in
Claude Code (debriefs/2026-07-10-T2.md), and the **telemetry** fix that made
`ccr_refs_retrieved` honest (debriefs/2026-07-10-T1.md).

## The redaction thread — and the gap it left open

[[Redaction Stage]] hardening ran through the batch. T7
(debriefs/2026-07-10-T7.md) fixed the entropy sweep eating repo paths
(`isPathLikeToken`) — the third distinct false-positive class documented on that
page after integrity hashes (§31) and unbounded-length blobs (§37). Crucially,
T7 *discovered but did not fix* a **credit-card / Luhn false-positive** on sparse
space-separated digit runs. That deferral is now **ROADMAP R1.3** and is a
first-class task in `R1_BATCH.md` — the loop from "found while debugging" to
"scheduled task" is the intended path (verification-notes §50).

## Patterns worth reusing (they recurred, so they're now conventions)

- **Append-only JSONL + corrupt-trailing-line tolerance** for any local log
  (telemetry, notes, distill drafts) — crash-mid-write safe by construction.
- **Redact-before-storage as belt-and-suspenders, never the primary control.**
  The primary control is that webcache/hook input is *already* pipeline-redacted;
  the second `stripKnownSecrets(pipelineRedact(...))` pass on model-authored text
  is defense in depth, never a reorder of the hard-rule pipeline.
- **Thin testable business logic + thin CLI wrapper** (`notes.ts`, `distill.ts`,
  `ollama.ts`): the command in `main.ts` stays a wrapper; the logic takes DI
  seams and gets faked in tests (no real Ollama in CI).
- **Fail-open everywhere off the critical path** — telemetry writes, watcher
  `error` events, distill pointers in the WebFetch hook: a failure there must
  never break the request/hook/reindex the user is waiting on.
- **Frozen-interface discipline.** Only one frozen contract changed all batch:
  T5 added `listPages()` to `WikiReader`, flagged loudly with a contract-test
  case first. Backward-compatible telemetry evolution (T1's `kind?` discriminant)
  shows the alternative — extend without breaking old data.

## A durable debugging lesson

T7 logged the sharpest operational lesson: **when the redaction pipeline itself
is a suspect, do not trust a repeated Read/Grep diff as ground truth** — a
`[REDACTED:…]` in your *view* at slider ≥1 does not mean the bytes on disk
changed. Drop to level 0, shell out to a process-level check (`grep -c`, byte
count, the test runner), or work from a session with `ANTHROPIC_BASE_URL` unset.
This is why `R1_BATCH.md` §0 carries an explicit redaction-work escape hatch for
the R1.3/R1.4 secret-pattern tasks (verification-notes §23).

## Open follow-ups this batch spawned

Tracked forward rather than lost:

- **Credit-card Luhn false-positive** → ROADMAP R1.3 (scheduled).
- **note → distill shaping** — distillation covers URLs only; `notes.jsonl` still
  needs manual distillation → ROADMAP R3.5.
- **Auto-watch-on-serve** and **session-start wiki-index injection** — both
  deliberately declined as out-of-scope bigger features (new hook-output
  contract, staleness handling); candidates if the manual paths prove
  insufficient.

See also [[Wiki-First Knowledge]], [[Distillation Pipeline]], [[Redaction Stage]],
and ADR-0001 (docs/decisions/ADR-0001-file-watcher.md).
