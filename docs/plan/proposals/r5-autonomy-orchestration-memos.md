# R5 — Autonomy & orchestration: design memos

> **Status: DESIGN MEMOS — NOT a build authorization.** R5 is ⛔ ON HOLD
> (spec Decision 36). Per the standing WS-F gate (spec Decisions 20/21,
> `IMPLEMENTATION_PLAN.md` §6), **each task needs its own design memo AND a
> separate explicit user "go" before any code is written.** This document
> satisfies the *memo* half for the five R5 tasks so they are review-ready; it
> does **not** lift the hold. Nothing here touches a frozen `src/interfaces/`
> contract or shipped scope, and none of it may proceed until the R4
> co-developer loop is judged robust and the user green-lights the specific
> task.
>
> **Written 2026-07-16.** Sources: spec Decisions 20a/20b/20d/20g, 21a/21c
> (`docs/golem-spec.md`), the WS-F↔ROADMAP crosswalk (`IMPLEMENTATION_PLAN.md`
> §6), the Risks table (spec §8), and a read of the existing code each memo
> builds on (cited inline).

## Hard rules that bind every R5 task

Restated so no memo below has to relitigate them:

- **Redaction is never weakened or reordered** (CLAUDE.md T-C3). Any task that
  persists, forwards, or renders request/response content runs it through the
  already-redacted body, never raw bytes.
- **Proxy byte-fidelity at level ≤1** is untouched — none of these tasks sit on
  the request-transform path; they observe/orchestrate around it.
- **Cross-platform** (`node:path`, `env-paths`, argument-array spawning, no
  `/tmp`, no POSIX-only signals). R5.1 (process relaunch) and R5.3 (spawning
  local conversations) are the sharp edges here.
- **No heavyweight native deps in the default install** — a TUI (R5.2) or
  scheduler must stay pure-TS or be an opt-in extra.
- **zod at every new external surface** (task files, state API payloads, hook
  I/O); internal code trusts types.

---

## R5.1 — Durable task queue & auto-resume (WS-F1 / spec 20a)

**Why (dogfooding origin).** Spec 20a was prompted by *repeatedly losing
in-flight agent work to session/credit limits* — the single most-felt pain in
building Golem itself. A task should be a checkpointed unit: interrupted →
re-queued, not lost.

**What exists today.** Nothing. `grep` for `worktree` / `.golem/tasks` /
`taskQueue` in `src/` returns no hits; §2.2's "device registry & job scheduler"
is a P4 Fleet concept, not built. This is greenfield — which is why it is
sequenced first (it is a dependency of R5.3 and 21a).

**Proposed design.**
- **Task store** at `<project>/.golem/tasks/` — one JSON file per task,
  zod-validated. Fields (draft): `id`, `createdAt`, `state`
  (`queued|running|blocked|paused|done|failed`), `prompt`, `agentType`,
  `worktree` (path + base commit + dirty-file manifest), `idempotencyKey`,
  `checkpoints[]` (plan step + status), `lastError`. A small
  `TaskStore` seam (new, non-frozen) with a file-backed impl, mirroring the
  `JsonFileSliderStore` / telemetry `jsonl-store` conventions already in repo.
- **Capacity detection** (spec's open question — no paid status API). Two
  honest options, neither guessing:
  1. *User-declared reset window* — the user tells Golem when their limit
     resets (or it reads the `rate_limits.{five_hour,seven_day}` reset stamps
     Claude Code already puts on statusline stdin — see R5.2 / verification-
     notes §28). Deterministic, no probing.
  2. *Poll-with-backoff on a cheap request* — only if (1) is unavailable;
     exponential backoff, capped, logged. Never a tight retry loop.
  Recommend shipping (1) first; (2) is a fallback behind a flag.
- **Resume = replay the plan, not blind re-exec** (spec Risk row, 20a). On
  relaunch, side-effecting steps re-verify state against their idempotency key
  before re-applying; read-only steps just re-run. This is the safety crux and
  ties directly to R5.4's guardrails.
- **Relaunch mechanism** — spawn the agent via argument-array `child_process`
  (cross-platform), restoring the worktree. Whether Golem drives Claude Code
  headlessly or re-primes an interactive session is the hardest open edge
  (shared with 21b's "continue ≠ approve" problem) — see Open questions.

**Interfaces/scope.** New non-frozen `TaskStore` seam + file impl; new CLI
verbs (`golem task {add|list|show|resume|cancel}`); no frozen interface
touched. Medium–large.

**Open questions.** (a) Interactive-session resume has no clean Claude Code
TUI API — likely needs headless/SDK mode or a PTY wrapper (genuine unknown,
verify against live Claude Code docs before build). (b) Worktree dirty-state
capture/restore fidelity. (c) Idempotency-key design for the common
side-effecting steps (git push, file write, deploy).

**Build gate.** Explicit ask required. Recommend a spike on the resume
mechanism (headless vs PTY) *before* committing to the full store design.

---

## R5.2 — Dashboard-as-sidecar completion (WS-F10 / spec 21c)

**Why.** Surface live token usage, savings, storage, and status *alongside* the
Claude Code conversation, from one state source, so terminal and VS Code never
diverge — and so the eventual 21b remote app consumes the same API.

**What exists today (substantial).** The statusline renderer and the state
plumbing are already shipped: `src/cli/statusline.ts` (the `golem statusline`
command, verification-notes §28), `src/dashboard/server.ts` +
`src/dashboard/index.ts` (the loopback dashboard), `src/hooks/session-state.ts`,
and `src/cli/proxy-state.ts`. The VS Code extension panel also exists
(`vscode-extension/`). So 21c is **~70% done**; R5.2 is the completion, not a
rebuild.

**Proposed design (the remaining gap).**
- **Consolidate the single session-state JSON API.** Audit whether
  `dashboard/server.ts` + `hooks/session-state.ts` already expose one coherent
  read model (proxy reachability + upstream identity, slider level, A4
  telemetry savings/per-stage, CCR/knowledge/telemetry storage sizes). If they
  diverge, unify them behind one documented, zod-described payload — this is the
  contract every renderer and the future remote app depends on.
- **Build `golem watch`** — the one genuinely missing renderer: a full-screen
  TUI (run in a second pane / tmux split) polling the state API, the "expanded"
  sidecar for when one status-line row isn't enough. **Cross-platform + no
  heavyweight dep:** prefer hand-rolled ANSI or a tiny pure-TS TUI lib; if a
  heavier lib is wanted it must be an opt-in extra, not a core dependency.

**Interfaces/scope.** No frozen interface. New `golem watch` command; possible
tightening (not breaking) of the state payload. Small–medium — most risk is in
*not* re-inventing what the dashboard server already returns.

**Open questions.** TUI lib vs hand-rolled ANSI; polling cadence vs a lighter
IPC; keeping statusline fast (cache Golem state between turns, per the doc's
perf warning). Verify Claude Code statusline stdin fields against live docs
before relying on new ones.

**Build gate.** Explicit ask. Lowest-risk R5 task; a reasonable *first* R5
build once the hold lifts, because it's mostly consolidation of shipped parts.

---

## R5.3 — Task/question queue + local conversation multiplexing (WS-F2 + F8 / spec 20b, 21a)

**Why.** A single serialized Claude session is the bottleneck. Let the user
enqueue prompts without blocking; service *overlapping* conversations locally
(triage, drafts, retrieval) on the Ollama tier (WS-D), escalating to Claude
only where cloud quality is needed. 21a adds mid-thread escalation: hand a hard
sub-task to a stronger model and fold the result back in.

**What exists today.** The local-inference substrate is shipped — `coder`
(drafter role), the tiered catalog (`src/inference/catalog.ts`), role routing
in `InferenceService`, and the slider. R5.3 orchestrates *over* these; it does
not add a new model layer. It depends on **R5.1's task queue** for durable
enqueueing.

**Proposed design.**
- **Non-blocking enqueue** on top of R5.1's `TaskStore`: a question/prompt is a
  task with `state: queued`; the user keeps working.
- **Local multiplexing**: when Ollama is up, service queued items locally
  (triage/draft/retrieve via existing roles) concurrently, bounded by a small
  worker cap (respect the machine — mirror the drafter's single-flight
  discipline). Results attach to the task for later review.
- **Escalation/handoff (21a)**: an explicit, inspectable boundary — a local
  agent marks a sub-task "needs Claude", which becomes a Claude-tier task with
  the local context folded in as grounding (reuse R4.2's `assembleHits` /
  grounding block). **Never auto-escalate silently** — either ask or surface
  the decision (consistent with Decision 31: the slider never auto-engages the
  model; escalation is an explicit act, like `coder`).

**Interfaces/scope.** No frozen interface. Builds on `TaskStore` (R5.1) +
`InferenceService`. Medium–large. Hard part is *coherence*, not plumbing.

**Open questions.** Keeping a conversation coherent when consecutive turns come
from different models; when to auto-escalate vs ask (default: ask); context
handoff fidelity across models with different tool-use formats.

**Build gate.** Explicit ask **and R5.1 first** (hard dependency).

---

## R5.4 — Cruise-control autonomy modes with approval gates (WS-F4 / spec 20d)

**Why.** A directive layer above individual commands: the user states an
*outcome* ("draft a plan", "edit files to do X", "deploy") and Golem drives the
agent loop at a chosen **autonomy level**, more flexible than a binary
auto/manual toggle.

**Safety is the feature, not a wrapper on it.** Spec Risk row (20d) is a hard
requirement: **mandatory approval gates for irreversible/outward-facing steps**
(deploys, pushes, deletes, external calls); autonomy level is *explicit and
per-task*; **dry-run default for destructive steps**; a full action log. This
mirrors the harness rule Golem itself runs under ("confirm hard-to-reverse or
outward-facing actions unless durably authorized"). The default-deny posture
must survive link loss and ambiguity.

**What exists today.** The MCP tool surface, the slider, the guidance-file
writer, and telemetry (for the action log). Claude Code's own
`PreToolUse`/`PermissionRequest` hooks (spec 21b, verification-notes §8) are the
natural enforcement point — a hook returning `permissionDecision: allow|deny`
is exactly how an approval gate is applied without an org account.

**Proposed design.**
- **Autonomy levels** (draft): `manual` (approve every step) → `assisted`
  (auto read-only, gate writes/outward) → `outcome` (drive the loop, gate only
  the irreversible/outward set) — never a level that removes the irreversible
  gates. Level is set per task, surfaced loudly (like slider 0's warnings).
- **Gate enforcement via hooks**: a `PreToolUse`/`PermissionRequest` hook reads
  the task's autonomy level + the pending action's classification
  (read/write/destructive/outward) and returns allow/deny; destructive steps
  dry-run first. All decisions append to an auditable action log.
- **Action classifier**: a conservative allowlist — anything unrecognized is
  treated as gated, never as auto-approved.

**Interfaces/scope.** No frozen interface. New hook(s) + a small autonomy-policy
config leaf + action log. Medium. **Security-adjacent** (Risk row): the memo
must include a threat model and default-deny proofs before build.

**Open questions.** Hook timeout vs a slow human (shared with 21b) — past the
window, fall back to the native local prompt, never auto-proceed. Action
classification coverage. Interaction with R5.1 resume idempotency.

**Build gate.** Explicit ask **+ a written threat model reviewed** (Risk-table
task). Do not build the "drive the loop" level before the gate enforcement is
proven.

---

## R5.5 — Writing-style adaptation & prompt translation (WS-F7 / spec 20g)

**Why.** Translate raw user input into high-yield prompts — learn (i) the
user's natural style and (ii) phrasing empirically effective with Claude — so
raw notes never require the user to "prompt well." Local-LLM-powered (WS-D).

**What exists today.** The local-inference substrate (roles, catalog) and A4
telemetry (the scoring substrate). This is the most research-shaped R5 task
(🔬) and the least infrastructural.

**Proposed design (spike-first).**
- **Never silently alter intent** (spec's own hard constraint): always show the
  translated prompt; fully user-inspectable and disableable. Translation is a
  suggestion surfaced before send, not an invisible rewrite on the request
  path — which also keeps it off the byte-fidelity-critical proxy path.
- **Scoring**: start with *inferred* outcome signals (retries, edits,
  acceptance) plus optional explicit thumbs; the mapping improves over time.
  Store scores in telemetry (non-frozen, additive fields).
- **Translation**: a local-LLM step (WS-D) that rewrites a raw note into a
  structured prompt, grounded in the user's own accepted history.

**Interfaces/scope.** No frozen interface. Telemetry additions + a local
translation step + an inspection surface. Small–medium spike, then measure.

**Open questions (spec's, unresolved).** How interactions are scored (explicit
vs inferred); avoiding a feedback loop that optimizes for the wrong signal;
proving it never distorts intent. Strong candidate to *measure demand* before
building — it may not be worth it versus the co-developer core.

**Build gate.** Explicit ask. Recommend a small spike + a demand check before
any real investment; lowest priority of the five.

---

## Recommended sequence (if/when the hold lifts)

1. **R5.2** — lowest risk; mostly consolidates shipped parts + one TUI.
2. **R5.1** — foundational; unblocks R5.3/21a. Spike the resume mechanism first.
3. **R5.4** — safety-gated; needs a reviewed threat model. Its hook enforcement
   is reused by R5.3 escalation and any autonomous resume.
4. **R5.3** — depends on R5.1 (+ benefits from R5.4's gates).
5. **R5.5** — research/demand-gated; last.

Each step is still a separate explicit ask. This ordering is a recommendation,
not a commitment; the hold lifts only on the user's call, informed by R4.3/R4.7
measurements (ROADMAP "Concentrated decision/research backlog").
