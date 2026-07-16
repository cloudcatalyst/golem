# Golem Roadmap

> **Rewritten 2026-07-16 (spec Decision 36).** This is the durable, multi-release
> view that sits above `IMPLEMENTATION_PLAN.md` (workstreams, frozen interfaces)
> and the current actionable batch file (`R4_BATCH.md`). When a release's work is
> picked up, spin its tasks into a batch brief in the style the repo already
> uses; when it lands, mark it here and move on.

## The organising intent (Decision 36)

Everything below is sorted by one criterion: does it serve the working pattern
that inspired the wiki-first pivot (spec Decision 28 — the "LLM Wiki /
developer's second brain" article)?

1. **Plan together.** A place where the user and Claude collaborate on planning:
   reading captured notes and ideas, and turning them into tasks.
2. **Distill everything.** The project and its research distilled into the
   committed wiki; the knowledge base collects raw articles; web fetches are
   cached and served offline.
3. **A local co-developer.** A robust, token-friendly local coder that drafts so
   the paid model can judge.

Goal 2 is largely shipped (WS-W W1–W4). Goals 1 and 3 landed in **R4** (all
seven tasks done, 2026-07-16). The user then lifted the R5 hold and kicked off
**R5 — Autonomy & orchestration**, now the active release (`R5_BATCH.md`). The
multi-provider / remote cluster (R6, incl. the companion app) stays **on hold**.

## Where we are (validated 2026-07-16)

- **Baseline green:** `tsc --noEmit`, `biome check`, and `vitest run`
  (886 tests) all pass.
- **R1–R3 shipped** (see below). P0/P1 + the wiki knowledge loop are live and
  dogfooded daily; compression is honestly scoped as situational (Decision 23);
  positioning is the universal pre-LLM processor (Decision 32).

## Shipped

Details live in the wiki (`docs/wiki/debriefs/`, `docs/wiki/syntheses/`) and the
spec Decisions Log; the batch briefs themselves were retired (git history has
them, Decision 36).

- **R1 — Honest baseline** (2026-07-11): net-of-cache A/B infra (§54),
  positioning Decision 32, redaction false-positive + provider-rule fixes,
  cross-OS e2e smoke. Open remainder: R1.6 (macOS/Linux Ollama manual
  verification — blocked on hardware, see
  `wiki/questions/r1.6-ollama-verification-blocked.md`).
- **R2 — Real savings, evidence-gated** (2026-07-11): cache-safe bypass A/B
  infra (R2.6, live A/B deferred), `avoidedUpstream` telemetry + context
  substitution (R2.2), local-answer contract (R2.3 / Decision 33 — still
  PROPOSED pending human review of a real served answer), expand↔Headroom-CCR
  backfill (R2.4).
- **R3 — Knowledge depth** (2026-07-12 → 2026-07-15): chat-judge rerank
  (Decision 34), HTML/PDF extractors, tree-sitter chunker (opt-in), user-scope
  wiki federation + weekly synthesis (W4), note→distill shaping, MEMORY-scope
  federation via the Headroom memory sidecar (C4), LanceDB no-go spike (R3.7 —
  recommended the `#flush()` stream-write fix, scheduled as R4.6).

## Carried-over loose ends (visible, not lost)

| Item | Status | Where tracked |
|---|---|---|
| Decision 33 local-answer: flip PROPOSED→ACCEPTED after a human reviews a real served answer | **reviewed 2026-07-16 → stays PROPOSED** (served answer was wrong; test can't run as designed — no semantic embedder). Flip now gated on a fair re-review after `nomic-embed-text` + semantic reindex. | spec Decision 33; verification-notes §64 |
| R2.6 live semantic-forced A/B on real traffic | deferred (needs a proxy restart mid-dogfood; only meaningful on non-caching upstreams) | verification-notes §60 |
| R1.6 macOS/Linux Ollama setup checklist | blocked on non-Windows hardware | wiki questions page |
| `FileVectorDriver.#flush()` crash past ~30k chunks | scheduled | **R4.6** |

---

## Releases

Legend: 🔬 research/spike · 🧭 decision · 🔒 security/ToS gate · 🛠️ build

### R4 — Co-developer core (ACTIVE)
Make goals 1 and 3 real: a planning-collaboration surface, a grounded,
measured, iterating local coder, and the last robustness gaps in the
distill/KB loop. **Active batch: `R4_BATCH.md`.**

| # | Task | Type | Source |
|---|---|---|---|
| R4.1 | ~~**Planning-collaboration surface:** `docs/plan/BACKLOG.md` ideas inbox + `/golem/plan` skill — reads `golem note` captures, wiki `questions/`, pending distill drafts, and this ROADMAP, then co-drafts task proposals with the user (plan-gated writes; approved tasks graduate into the ROADMAP/batch).~~ — **DONE** 2026-07-16: shipped `docs/plan/BACKLOG.md` (Date/Idea/Source/Status inbox, human-editable + plan-gated agent appends) and the `/golem/plan` skill (`src/cli/skills.ts`, installed by `golem init`): read-only gather of notes/`questions/`/distill drafts/BACKLOG/ROADMAP → grouped candidates → plan-gated proposals → cite-sources/flag-inference/admit-gaps contract. +4 unit tests, 890 green. See debriefs/2026-07-16-R4.1.md. | ✅ | Dec 36, Dec 20f |
| R4.2 | ~~**Coder grounding:** retrieval-augmented drafting — `coder` auto-injects relevant KB/wiki hits (size-capped, opt-out param) so local drafts stop being context-blind.~~ — **DONE** 2026-07-16: extracted a shared `assembleHits` (graph→vector→boost→rerank, reused by `search` and coder), added `gatherGrounding` (≤4 hits/≤4000 chars, `ground` opt-out + `project_id` inputs, `grounding:{sources,injected_chars}` in output, degrades to ungrounded on any failure). No frozen interface touched. +5 tests, 895 green. See debriefs/2026-07-16-R4.2.md. | ✅ | Dec 36 |
| R4.3 | ~~**Honest tool telemetry:** instrument `search`/`fetch`/`ingest`/`wiki_read`/`coder` with per-call events + a drafted-locally token bucket — closes the §59 gap so "token-friendly" is measured, not asserted.~~ — **DONE** 2026-07-16: new `kind:"tool"` telemetry event + `recordToolCall`/`aggregateToolUsage`; the 5 tools record duration/result-bytes (coder also model + drafted-locally chars) fire-and-forget; surfaced in the `stats` MCP tool (`tool_usage`) and `golem stats` ("local tools" section). No frozen interface touched. +6 tests, 901 green. See debriefs/2026-07-16-R4.3.md. | ✅ | §59, Dec 24 |
| R4.4 | ~~**Coder iteration loop:** optional draft → local-judge critique → revise pass (existing `drafter`/`judge` roles, no interface change); harden the `/golem/develop` skill around it.~~ — **DONE** 2026-07-16: `src/mcp/coder-refine.ts` `refineDraft` (judge critiques via forced-JSON verdict, drafter revises once on high/medium issues, best-effort fallback); `coder` gains `refine` (default off) + `refinement` output; `/golem/develop` hardened (grounding auto, refine for non-trivial, skip coder for tiny edits). No interface change. +9 tests, 912 green. See debriefs/2026-07-16-R4.4.md. | ✅ | Dec 35 |
| R4.5 | ~~**Distill-draft promotion UX + wiki-lint cleanup:** review/apply flow for `.golem/distill/` drafts (`golem wiki promote`-style), closing capture → distill → promote; plus fix the 18 pre-existing `golem wiki check` issues in dated pages (broken/missing wikilinks) and consider wiring the check into CI.~~ — **DONE** 2026-07-16: `golem wiki promote [id\|--list\|--yes]` (`src/cli/promote.ts`, append-and-refine upsert + draft consume, Decision 26 non-TTY refuse); checker now ignores code-fenced/inline wikilinks; all 18 lint issues fixed (17 link repairs + code-strip); `wiki check` wired into CI. `golem wiki check` → 0 issues. +9 tests, 921 green. See debriefs/2026-07-16-R4.5.md. | ✅ | WS-W W3 follow-up, Dec 36 debrief |
| R4.6 | ~~**`FileVectorDriver.#flush()` stream-write fix** so the raw-article KB can grow past ~30k chunks without crashing.~~ — **DONE** 2026-07-16: `#flush()` streams JSON lines via `createWriteStream` (backpressure-aware, atomic temp+rename kept) instead of one `Array.join` string; benchmark confirms 50k/60k no longer hit the `RangeError` wall (was 30k–50k), search latency unchanged. +1 test, 922 green. See debriefs/2026-07-16-R4.6.md. | ✅ | R3.7 spike |
| R4.7 | ~~**Drafter quality/catalog re-verification:** re-verify current best small coder models (advisory per Decision 6), measure coder draft accept-rate; carry R1.6's manual checklist where hardware allows.~~ — **DONE** 2026-07-16: re-verified catalog (no change — `qwen3-coder` ships only 30b/480b, no small tags; qwen2.5-coder still best for single-function drafts); measured ungrounded baseline 2 accept / 3 revise / 0 reject (accept for self-contained, revise for project-integrated); R1.6 still hardware-blocked. See verification-notes §63, syntheses/r4.7-drafter-quality-baseline.md. | ✅ | Dec 6, R1.6 |

### R5 — Autonomy & orchestration — 🚧 ACTIVE
Formerly R4. Hold lifted 2026-07-16 by explicit user call (R4 co-developer loop
judged robust — all seven R4 tasks landed). Design memos:
`docs/plan/proposals/r5-autonomy-orchestration-memos.md`; active batch:
`docs/plan/R5_BATCH.md`. R5.4 additionally carries a security gate — its threat
model is written as an ADR before its enforcement code.

| # | Task | Type | Source |
|---|---|---|---|
| R5.1 | ~~Durable task queue & auto-resume (persist prompt+agent+worktree, relaunch on capacity).~~ — **DONE** 2026-07-16: non-frozen `TaskStore` seam + file impl (`src/tasks/`, one zod JSON per task under `.golem/tasks/`), `golem task add/list/show/resume/cancel`. Resume mechanism verified as headless `claude -p --resume <session-id>` — no PTY (verification-notes §65). Capacity gate via `notBefore`; resume prints by default, `--spawn` opt-in (no shell). +25 tests, 977 green. See debriefs/2026-07-16-R5.1.md. | ✅ | 20a / WS-F1 |
| R5.2 | ~~Dashboard-as-sidecar completion (statusline + VS Code panel exist; add the shared session-state JSON API + `golem watch` TUI).~~ — **DONE** 2026-07-16: consolidated `SessionStateReport` + zod contract (`src/cli/session-report.ts`), `golem watch` full-screen TUI (hand-rolled ANSI, no deps, `src/cli/watch.ts`), `.golem/` storage sizing (`src/cli/storage-size.ts`), dashboard `/api/state` endpoint. No frozen interface touched. +14 tests, 952 green. See debriefs/2026-07-16-R5.2.md. | ✅ | 21c / WS-F10 |
| R5.3 | Task/question queue + local conversation multiplexing. | 🔬🛠️ | 20b/21a |
| R5.4 | ~~Cruise-control autonomy modes with approval gates.~~ — **DONE** 2026-07-16: threat model written first (ADR-0002); `src/autonomy/` (levels manual/assisted/outcome, conservative classifier, gate) + `PreToolUse` hook (`golem hook pre-tool-use`) + `golem autonomy show/set/wire/unwire/log`. Default-deny/fail-closed proven — never auto-approves destructive/outward, errors → native prompt. Opt-in (not auto-wired by init); surfaced in the R5.2 report. +27 tests, 1004 green. See debriefs/2026-07-16-R5.4.md. | ✅ | 20d / WS-F4 |
| R5.5 | Writing-style adaptation & prompt translation (local-LLM, fully inspectable). | 🔬 | 20g |

### R6 — Multi-provider & remote — ⛔ ON HOLD (security/ToS-gated)
Formerly R5. Same hold + per-task design-memo gate as R5; R6.3 is the
Decision 21b **companion app** the user has explicitly deferred.

| # | Task | Type | Source |
|---|---|---|---|
| R6.1 | Provider-agnostic adapters (front Foundry/OpenRouter; Anthropic byte-faithful path untouched). Positioning-unblocked by Decision 32; build still needs its memo + explicit ask. | 🧭🛠️ | Dec 22/32 |
| R6.2 | Account switching + multi-LLM/quota routing. | 🔒 | 21d/21e |
| R6.3 | Remote steering / permission-granting — companion app + locally-hosted web (self-hosted relay, mTLS, default-deny on link loss). | 🔒🔬 | 20c/21b |
| R6.4 | Cost-governance benchmarks vs Claude's cost doc (continuous once picked up). | 🛠️ | 21f |

---

## Concentrated decision/research backlog

The gates that block downstream work, in priority order:

1. **🔬 R4.7 drafter quality** — the co-developer thesis stands or falls on
   whether local drafts are good enough to be worth reviewing; measure, don't
   assume.
2. **🧭 Decision 33 human review** — one real served local answer, reviewed,
   then flip to ACCEPTED (or retire it).
3. **🔒 R5.4 + all of R6** — autonomy, account-switching, remote approval each
   need a written memo + review before code, after the R4 hold lifts.

## Deferred / not scheduled

The **hosted workspace/org knowledge tier** (WS-F5's upper tiers — P4+,
candidate paid) remains the only work off the roadmap entirely. The WS-F↔
ROADMAP crosswalk lives in `IMPLEMENTATION_PLAN.md` §6; the full spec rationale
is the Decisions Log (`docs/golem-spec.md`, Decisions 20–36).
