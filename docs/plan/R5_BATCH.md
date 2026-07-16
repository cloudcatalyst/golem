# R5 batch — Autonomy & orchestration

> **Written 2026-07-16.** The user lifted the R5 hold (spec Decision 36) and
> authorized kicking off the whole release without per-task approval pauses.
> The design-memo half of the standing WS-F gate is satisfied by
> `docs/plan/proposals/r5-autonomy-orchestration-memos.md` (read it first — this
> brief does not restate the memos). This is the current actionable batch; the
> multi-release view is `ROADMAP.md`; the workstream/interface reference is
> `IMPLEMENTATION_PLAN.md`; the spec Decisions Log (`docs/golem-spec.md`) is
> authoritative. Replaces the completed `R4_BATCH.md`.

R5's theme: a directive/orchestration layer **above** individual commands —
durable tasks that survive session/credit limits, a consolidated sidecar view,
local conversation multiplexing, cruise-control autonomy with hard approval
gates, and prompt translation. None of it sits on the byte-fidelity proxy
transform path; it observes/orchestrates around it.

## 0. Session setup (once)

Same as R4: `CLAUDE.md` + `CLAUDE.local.md` hard rules override this file
(never weaken redaction; proxy byte-fidelity at level ≤1; cross-platform —
`node:path`, `env-paths`, argument-array spawning, no `/tmp`, no POSIX-only
signals; frozen `src/interfaces/` need contract tests first; no heavyweight
native deps in the default install). Wiki-first ladder + `coder`-first drafting
per `CLAUDE.local.md`. Baseline at batch start: 922 tests green.

## 1. Batch-wide definition of done (every task)

- Opening moves: wiki index skim → `search`/`wiki_read` for prior art →
  `coder` draft where the task pays for the round trip.
- `tsc --noEmit`, `npm run lint`, `npm run format:check`, `npx vitest run` all
  green on the task's final commit.
- New behavior tested at the right layer; **zod at every new external surface**
  (task files, state API payloads, hook I/O).
- A dated debrief in `docs/wiki/debriefs/` (plan-gated).
- Conventional commit(s), task ID in the title (e.g. `feat(cli): R5.2 ...`).
- Mark the task done in `ROADMAP.md` when it lands.

## 2. Recommended order (from the memos §"Recommended sequence")

**R5.2 → R5.1 → R5.4 → R5.3 → R5.5.** R5.2 is lowest-risk (mostly consolidates
shipped parts). R5.1 is foundational and unblocks R5.3. R5.4 is security-gated
and its enforcement is reused by R5.3 escalation + autonomous resume. R5.3
depends on R5.1. R5.5 is research/demand-gated, last.

### R5.2 (🛠️) — Dashboard-as-sidecar completion (WS-F10 / spec 21c)
Consolidate the divergent read models — `dashboard/server.ts`'s savings-focused
`DashboardSnapshot` and `cli/statusline.ts`'s liveness-focused `GolemState` —
into **one zod-described session-state payload** (proxy reachability + upstream
identity, slider level + redaction-off flag, telemetry savings/per-stage, CCR/
tool usage, storage sizes, blocked flag, local-model reachability). Every
renderer and the future 21b remote app reads that one contract. Then build the
one missing renderer, **`golem watch`** — a full-screen TUI (second pane / tmux
split) polling the state API. Cross-platform, **no heavyweight dep** (hand-rolled
ANSI). Memo: R5.2.

### R5.1 (🔬🛠️) — Durable task queue & auto-resume (WS-F1 / spec 20a)
Greenfield. A `TaskStore` seam + file impl under `<project>/.golem/tasks/`
(one zod-validated JSON per task), CLI verbs (`task add|list|show|resume|
cancel`). Resume = replay the plan with idempotency re-verification, never
blind re-exec. **Spike the resume mechanism (headless vs PTY) before committing
to the full store design** — verify against live Claude Code docs. Memo: R5.1.

### R5.4 (🔒🛠️) — Cruise-control autonomy modes + approval gates (WS-F4 / spec 20d)
**Safety is the feature.** Write the threat model + default-deny proofs FIRST
(Risk-table requirement) — this batch produces it as `docs/wiki/decisions/` (an
ADR) before the enforcement code. Autonomy levels (`manual|assisted|outcome`),
never a level that removes the irreversible/outward gates; enforcement via a
`PreToolUse`/`PermissionRequest` hook returning allow/deny; conservative action
classifier (unrecognized → gated); dry-run default for destructive steps; full
action log. Memo: R5.4.

### R5.3 (🔬🛠️) — Task/question queue + local conversation multiplexing (WS-F2+F8 / spec 20b, 21a)
Non-blocking enqueue on R5.1's `TaskStore`; service overlapping conversations
locally on the Ollama tier (bounded worker cap); explicit, inspectable
escalation to Claude (never silent — reuse R4.2 grounding for context handoff).
Depends on R5.1. Memo: R5.3.

### R5.5 (🔬) — Writing-style adaptation & prompt translation (WS-F7 / spec 20g)
Spike-first + demand check. Never silently alter intent — always show the
translated prompt, fully inspectable + disableable, off the proxy path.
Inferred outcome scoring in telemetry (additive fields). Lowest priority. Memo:
R5.5.

## 3. Post-batch

Mark tasks done in `ROADMAP.md`, record any new spec Decisions Log entries,
write the batch retrospective synthesis (mirroring
`syntheses/r4-co-developer-core-batch.md`), then revisit R6 with the user.
