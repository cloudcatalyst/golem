---
title: R4 batch — co-developer core
type: synthesis
tags: [r4, retrospective, coder, planning, wiki, telemetry]
sources: [docs/plan/R4_BATCH.md, docs/plan/ROADMAP.md]
created: 2026-07-15
updated: 2026-07-15
---

# R4 batch — co-developer core (retrospective)

R4's theme (Decision 36): make the two unbuilt legs of the second-brain
pattern real — a **planning-collaboration surface** and a **grounded, measured,
iterating local coder** — plus the last robustness gaps the loop leans on. All
seven tasks landed 2026-07-16.

## What shipped

- **R4.1 — planning surface.** `docs/plan/BACKLOG.md` ideas inbox + the
  `/golem/plan` skill close the second-brain loop into *tasks*: read notes /
  `questions/` / distill drafts / backlog / roadmap → propose plan-gated task
  entries, cite sources, flag inference vs. stated intent.
- **R4.2 — coder grounding.** Extracted one shared `assembleHits` (graph →
  vector → boost → rerank) reused by `search` and the coder; `gatherGrounding`
  injects size-capped local context into drafts (`ground` opt-out), degrading
  to ungrounded on any failure.
- **R4.3 — honest tool telemetry.** New `kind:"tool"` events for the five local
  tools (coder also records the drafted-locally char bucket), surfaced in the
  `stats` MCP tool and `golem stats`. Closes the §59 measurement gap.
- **R4.4 — iteration loop.** `refineDraft` (judge critique → drafter revise, one
  cycle, best-effort) behind an opt-in `refine` param; `/golem/develop`
  hardened to use grounding + refinement where they pay and skip `coder` for
  trivial edits.
- **R4.5 — promotion + lint.** `golem wiki promote` closes capture → distill →
  promote (append-and-refine, Decision 26 consent); the 18 pre-existing
  `wiki check` issues cleared (checker now ignores code-fenced links), and
  `wiki check` wired into CI.
- **R4.6 — scale fix.** `FileVectorDriver.#flush()` streams JSON lines instead
  of one `Array.join` string, removing the ~30k–50k-chunk `RangeError` wall.
- **R4.7 — re-verification.** Catalog re-verified (no change — no small
  `qwen3-coder` tags; qwen2.5-coder still best for single-function drafts) and
  the first measured drafter accept-rate baseline.

## Through-lines

- **Compose, don't duplicate.** R4.2's `assembleHits` and R4.4's reuse of the
  frozen `chat()` + `jsonSchema` mechanism (like rerank/distill) both added
  capability with zero interface change. No frozen interface was touched all
  batch.
- **Best-effort local enhancements never fail the caller.** Grounding (R4.2),
  refinement (R4.4), and tool telemetry (R4.3) all degrade silently — the same
  discipline as rerank and the fetch-hook backfill.
- **Measured, not asserted (Decision 23).** R4.3 makes the "token-friendly"
  claim measurable; R4.7 produced the honest baseline (2 accept / 3 revise /
  0 reject, ungrounded): coder is accept-quality for self-contained code,
  revise-quality for project-integrated code — which is the whole justification
  for R4.2 + R4.4.
- **Dogfooding as evidence.** Every task drafted with `coder` first; three of
  those drafts became R4.7's data points (all needed rewrites), logged in each
  debrief. See [[Wiki-First Knowledge]], [[Distillation Pipeline]].

## Open follow-ups

- **Grounded/refined accept-rate** re-measurement is gated on an MCP reconnect
  (the running `golem mcp serve` predates the R4.2/R4.4 build). R4.3's
  `tool_usage` bucket is the instrument.
- **R1.6 cross-OS Ollama checklist** still hardware-blocked (Windows only).
- **R5 (autonomy/orchestration) and R6 (multi-provider/remote, incl. the
  companion app)** remain ⛔ ON HOLD (Decision 36) — the hold lifts only on an
  explicit user call, informed by R4.3/R4.7's measurements.

