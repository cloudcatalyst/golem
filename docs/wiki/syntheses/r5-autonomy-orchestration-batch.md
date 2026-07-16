---
title: R5 — Autonomy & orchestration batch retrospective
type: synthesis
tags: [r5, retrospective, autonomy, orchestration, tasks]
sources:
  - docs/plan/R5_BATCH.md
  - docs/plan/proposals/r5-autonomy-orchestration-memos.md
  - docs/wiki/debriefs/2026-07-16-R5.1.md
  - docs/wiki/debriefs/2026-07-16-R5.2.md
  - docs/wiki/debriefs/2026-07-16-R5.3.md
  - docs/wiki/debriefs/2026-07-16-R5.4.md
  - docs/wiki/debriefs/2026-07-16-R5.5.md
created: 2026-07-16
updated: 2026-07-16
---

# R5 — Autonomy & orchestration (batch retrospective)

All five R5 tasks landed in one session (2026-07-16) after the user lifted the
R5 hold and authorized the whole release without per-task approval pauses. The
design-memo half of the WS-F gate was already satisfied
(`proposals/r5-autonomy-orchestration-memos.md`). Built in the memo's
recommended order: **R5.2 → R5.1 → R5.4 → R5.3 → R5.5.** Suite went 922 → **1018
green** (+96 tests); no frozen interface touched.

| Task | What | Debrief |
|---|---|---|
| R5.2 | Consolidated `SessionStateReport` (one zod payload) + `golem watch` TUI + `.golem` storage sizing + dashboard `/api/state` | [[2026-07-16 R5.2 — Dashboard-as-sidecar completion]] |
| R5.1 | Durable `TaskStore` + `golem task add/list/show/resume/cancel`; headless resume verified (no PTY) | [[2026-07-16 R5.1 — Durable task queue & auto-resume]] |
| R5.4 | Cruise-control autonomy + `PreToolUse` approval gate; threat model ADR-0002 first | [[2026-07-16 R5.4 — Cruise-control autonomy modes & approval gates]] |
| R5.3 | Local conversation multiplexing (`golem task run`) + explicit escalation | [[2026-07-16 R5.3 — Task/question queue + local conversation multiplexing]] |
| R5.5 | Prompt-translation spike (`golem prompt translate/accept`, demand-gated) | [[2026-07-16 R5.5 — Writing-style adaptation & prompt translation (spike)]] |

## Through-lines

1. **Verify before building against Claude Code.** The two hardest unknowns were
   resolved by reading live docs first, recorded dated: R5.1's resume mechanism
   (headless `claude -p --resume`, no PTY — verification-notes §65) and R5.4's
   `PreToolUse` `permissionDecision` schema. Neither was guessed.
2. **Default-deny / fail-open is the safety spine.** Every new surface degrades
   to the safe state: the gate emits nothing on error (→ native prompt, never
   auto-allow); local servicing leaves a task queued when the model is down;
   translation returns a suggestion, never an action; an invalid autonomy file
   reads as `manual`. Safety is a property of the code paths, not a wrapper.
3. **Local-first, explicit escalation.** R5.3 services work on the Ollama tier
   and only hands to Claude on an explicit act (Decision 31) — the same posture
   as `coder` and the slider. Nothing auto-escalates or auto-approves silently.
4. **One state contract.** R5.2's `SessionStateReport` became the shared read
   model every renderer + the future remote app consume; R5.4's autonomy level
   plugged straight into it.
5. **Composition over new layers.** Everything built on shipped parts —
   `InferenceService`, telemetry, the slider/statusline collectors, R4.2
   grounding, the hook infra. R5.1's `TaskStore` is the new foundation R5.3 (and
   a future auto-resume/auto-service daemon) extend.

## Mid-batch course-correction (user feedback)

The user caught a real process slip: I WebFetched the Claude Code hooks schema
without checking the KB first, where the answer already lived (§44/§8). Fix:
strengthened the `/golem/research` skill to encode the full ladder (wiki → local
KB → external web only after a miss → capture back), and saved it as a feedback
memory. Lesson: run a KB `search` before *every* external fetch, not once.

## Open follow-ups (deferred, not lost)

- **Auto-resume / auto-service daemon** — a background loop over
  `runQueueLocally` + capacity-gated `task resume`. The fields (`notBefore`,
  `worktree`) and mechanisms exist; the loop is deferred.
- **R5.3 grounding into `task run`** — wire the MCP `gatherGrounding` into local
  servicing (escalation already folds the local result).
- **R5.4 init-wiring** — the gate is opt-in (`golem autonomy wire`); auto-wiring
  into `golem init` is a separate, reviewable step (ADR-0002 §7).
- **R5.5 demand check** — measure whether prompt translation gets used before
  building the inferred-outcome scoring loop.
- **Worktree capture/restore fidelity** (R5.1 open question) — the schema
  carries it; the capture/restore mechanics are unbuilt.

R6 (multi-provider & remote, incl. the companion app) remains ON HOLD.
