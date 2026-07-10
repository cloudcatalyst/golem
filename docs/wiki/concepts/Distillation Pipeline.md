---
title: Distillation Pipeline
type: concept
tags: [knowledge, distillation, notes]
sources: [docs/plan/next_batch.md, src/cli/notes.ts]
created: 2026-07-10
updated: 2026-07-10
---

# Distillation Pipeline

The intended data flow for turning raw, low-friction capture into durable,
plan-gated wiki knowledge (spec Decision 20f, foundation for P2). Only the
capture stage exists so far (T4); this page will grow as the distillation
engine (T3) lands.

## Stage 1 — capture (built, T4)

`golem note "text"` is the fastest path into the pipeline: redact (reusing
`pipelineRedact` + `stripKnownSecrets`, `src/hooks/redact.ts` — same
never-weaken/never-reorder floor as every other storage path), then append a
`{ts, text}` line to `<project>/.golem/notes/notes.jsonl`. This is zone-1 raw
capture (local, gitignored, never committed — see [[Wiki-First Knowledge]]'s
zone table): instant and dependency-free, no inference on the capture path.
`golem note list` reads the same file back, newest first.

## Stage 2 — distill (not built yet, T3)

The planned next step: an engine that reads captured notes (and lazily,
webcache entries) and drafts a `questions/` or `artifacts/` wiki page from
them — shaped, not just copy-pasted, using the local model. Per T3's brief,
this is deliberately "the big one" and exercises `delegate`/summarizer
heavily.

## Stage 3 — promote (plan-gated, unchanged)

Whatever the distillation engine drafts is a proposal, never an automatic
write — same plan-gate as every zone-2 wiki write (spec Decision 29): propose,
get approval, then `wiki_upsert`.

See also [[Wiki-First Knowledge]].
