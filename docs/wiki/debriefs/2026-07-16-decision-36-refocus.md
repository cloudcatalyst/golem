---
title: 2026-07-16 Decision 36 — roadmap refocus + docs housekeeping
type: debrief
tags: [roadmap, planning, housekeeping, decision-36]
sources: [docs/golem-spec.md, docs/plan/ROADMAP.md, docs/plan/R4_BATCH.md]
created: 2026-07-16
updated: 2026-07-16
---

# Debrief — Decision 36: refocus on the co-developer core; docs housekeeping

The user asked to reorganise the remaining roadmap around the intent of the
article that inspired [[Wiki-First Knowledge]] (Decision 28): plan together
(notes/ideas → tasks), distill everything into the wiki, and build a robust,
token-friendly local coder co-developer — holding the companion-app /
orchestration / multi-provider cluster until that core is proven.

## What changed

- **Spec Decision 36** recorded (USER DECISION, `docs/golem-spec.md` v1.17).
- **ROADMAP rewritten:** R1–R3 collapsed to a Shipped section; new active
  release **R4 — Co-developer core** (R4.1 planning-collaboration surface,
  R4.2 coder grounding, R4.3 honest tool telemetry, R4.4 iteration loop,
  R4.5 distill-draft promotion, R4.6 flush stream-write fix, R4.7 drafter
  quality re-verification); old R4 → **R5 ON HOLD** (autonomy), old R5 →
  **R6 ON HOLD** (multi-provider/remote incl. the 21b companion app).
  `R4_BATCH.md` written as the active batch brief.
- **Divergence audit:** nothing shipped diverges from the article intent —
  the gap was that the *next-queued* work (old R4/R5) served a different goal,
  and the two article legs above had no scheduled tasks at all.
- **EOL name scrubbed:** the spec renamed `edge-offload-spec.md` →
  `golem-spec.md`, living prose de-EOL'd (updated in place per the
  Decisions 27/35 precedent); "EOL" survives only in dated Decisions Log
  entries and dated wiki records like this wiki's older debriefs.
- **Docs root cleaned:** `verification-notes.md` → `docs/plan/`;
  `docs/DEVELOPMENT.md` became the wiki page [[Dogfooding Golem]].
- **Retired:** `R1_BATCH.md`–`R3_BATCH.md` and the six P0-era
  `workstream-briefs/` (git history is the archive; debriefs/syntheses here
  remain the durable record). Cross-references repointed.

## Notes for future sessions

- Dated pages in this wiki still cite the old paths/filenames in their prose
  and frontmatter `sources` — that is deliberate provenance, not breakage.
- The R5/R6 hold lifts only on an explicit user call, informed by R4.3/R4.7
  measurements (draft accept-rate + measured local-tool savings).
