---
title: Distillation Pipeline
type: concept
tags: [knowledge, distillation, notes]
sources: [docs/plan/next_batch.md, src/cli/notes.ts, src/knowledge/distill.ts, src/knowledge/distill-store.ts]
created: 2026-07-10
updated: 2026-07-11
---

# Distillation Pipeline

The data flow for turning raw, low-friction capture into durable, plan-gated
wiki knowledge (spec Decision 20f, foundation for P2). Capture (T4) and
distill (T3) are both built; promote stays a human-in-the-loop step.

## Stage 1 — capture (built, T4)

`golem note "text"` is the fastest path into the pipeline: redact (reusing
`pipelineRedact` + `stripKnownSecrets`, `src/hooks/redact.ts` — same
never-weaken/never-reorder floor as every other storage path), then append a
`{ts, text}` line to `<project>/.golem/notes/notes.jsonl`. This is zone-1 raw
capture (local, gitignored, never committed — see [[Wiki-First Knowledge]]'s
zone table): instant and dependency-free, no inference on the capture path.
`golem note list` reads the same file back, newest first.

## Stage 2 — distill (built, T3)

`distillPage` (`src/knowledge/distill.ts`) calls the local `summarizer` role
with the page's already-redacted webcache text plus the wiki's current page
titles, forcing strict JSON output via `InferenceService`'s `jsonSchema`
option (the first real user of that frozen-contract field). It returns a
`DistillDraft`: title, kebab-cased slug, tags, a summary in the model's own
words citing the URL, and wikilinks — filtered down to only entries that
case-insensitively match a real existing title (canonical casing kept), so
the model can suggest links but never invent a page that doesn't exist. A
malformed or non-JSON response raises `DistillParseError` with the raw output
attached, rather than writing garbage.

Drafts land at `.golem/distill/<slug>.md` (`src/knowledge/distill-store.ts`)
— zone 1, gitignored, wiki-page-shaped from the start (`type: source`,
reusing the same `parseFrontmatter`/`serializeFrontmatter` the real wiki
pages use) so promoting one later is a copy into `sources/`, not a reformat.
Writing is keyed by slug: distilling the same URL again overwrites its prior
draft rather than accumulating stale copies.

Entry points:

- `golem wiki distill <url>` — distill one cached page now. Prefers an
  existing draft for that URL over re-distilling (pass `--force` to
  override); fails with a clear message (not a crash) when the URL isn't
  cached yet or no local model is configured.
- `golem wiki distill --pending` — list drafts awaiting review.
- **Lazy backfill**: per Decision 29 ("backfill lazily, on next access"), the
  WebFetch pre-hook (`runWebFetchPre`, `src/hooks/web-fetch.ts`) checks for an
  existing draft whenever it serves a cached URL and appends a one-line
  pointer to its served content — never the draft body, and never triggers a
  distill itself. That lookup runs in its own inner `try`/`catch` so a bug in
  it can never regress the hook's existing (and more important) cache-serve
  behavior.
- The `/golem/wiki-ingest` skill runs `golem wiki distill <url>` as its first
  step, so Claude reviews/refines an existing draft instead of re-distilling
  from scratch.

## Stage 3 — promote (plan-gated, unchanged)

Whatever the distillation engine drafts is a proposal, never an automatic
write — same plan-gate as every zone-2 wiki write (spec Decision 29): propose,
get approval, then `wiki_upsert`.

See also [[Wiki-First Knowledge]].
