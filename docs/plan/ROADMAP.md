# Golem Roadmap

> **Rewritten 2026-07-16 (spec Decision 36).** This is the durable, multi-release
> view that sits above `IMPLEMENTATION_PLAN.md` (workstreams, frozen interfaces)
> and whatever the current actionable batch file is. When a release's work is
> picked up, spin its tasks into a batch brief in the style the repo already
> uses; when it lands, mark it here and **retire the batch brief to git history**
> (completed briefs are not kept in the tree — R1–R5 + PRE-R6 were retired).

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
seven tasks done, 2026-07-16). **R5 — Autonomy & orchestration** then shipped,
followed by the PRE-R6 loose-ends closeout (2026-07-17), a run of standalone
UX/reliability decisions (snooze, coder-first enforcement, autonomy-gate toggle —
Decisions 38–40, 2026-07-22), and **R7 — Distribution, versioning & self-update**
(Decision 41, shipped 2026-07-22/23; first publish R7.5 left to the user). The
multi-provider / remote cluster (R6, incl. the companion app) stays **on hold**.

## Where we are (validated 2026-07-23)

- **Baseline green:** `tsc --noEmit`, `biome check`, and `vitest run`
  (1159 tests) all pass locally. **CI is billing-blocked** (GitHub Actions refuses
  to start jobs) — recent PRs merged on green *local* runs; unblocking it is a
  USER account step.
- **R1–R5 + R7 shipped** (see below). P0/P1 + the wiki knowledge loop are live and
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
- **R4 / R5** (2026-07-16): co-developer core and autonomy/orchestration — see
  their sections below.
- **Post-R5 standalone decisions** (2026-07-18 → 07-23): Golem snooze
  (Decision 38), coder-first enforcement (Decision 39), autonomy-gate toggle
  (Decision 40), and **WebFetch raw-page caching** (Decision 42 — the pre-hook
  fetches the raw page itself and serves it, so the cache holds pages not
  prompt-specific answers; debrief `2026-07-23-webfetch-raw-cache.md`).
- **R7 — Distribution, versioning & self-update** (Decision 41, 2026-07-22/23):
  see the R7 section below; first publish (R7.5) deferred to the user.

## Carried-over loose ends (visible, not lost)

**All cleared by the PRE-R6 batch (2026-07-17)** (batch brief retired to git
history). It closed LE1–LE5; the two remaining items are blocked-not-broken and
re-scoped (not open work).

| Item | Status | Where tracked |
|---|---|---|
| ~~Decision 33 local-answer: flip PROPOSED→ACCEPTED~~ | **✅ DONE — ACCEPTED 2026-07-17 (USER DECISION).** 3 embed-path fixes (§69), durable-prose restriction (§69c), [[Slider Levels]] + [[Compression]] pages; post-fix sample zero wrong. Opt-in/OFF-by-default. | spec Decision 33; verification-notes §64/§69b/§69c; PRE_R6 LE1 |
| ~~LE2 fair grounded/refined coder quality on the semantic index~~ | **✅ DONE 2026-07-17.** n=5 grounded+refine; grounding improves *revise-quality* on project-integrated drafts (verdict count flat); `refine` fired 0/5 rounds (follow-up in BACKLOG). | [[LE2 — grounded-refined coder quality]] |
| ~~LE3 grounding injection into `golem task run`~~ | **✅ DONE 2026-07-17** (feat(cli), shared `gatherGrounding`). | PRE_R6 LE3 |
| ~~LE4 ledger tidy + CI-green check~~ | **✅ DONE 2026-07-17** — CI green on `deccfc5`; R2.6/R1.6/R5.5 re-scoped below. | PRE_R6 LE4 |
| ~~LE5 semantic embed path robustness (incl. LE5c reindex clear)~~ | **✅ DONE** (`deccfc5`). | PRE_R6 LE5 |
| ~~`FileVectorDriver.#flush()` crash past ~30k chunks~~ | **✅ DONE** — R4.6. | R4.6 |
| R2.6 live semantic-forced A/B on real traffic | **re-scoped: unblocks-with-R6.1** (only meaningful on a non-caching upstream, which needs the provider adapters). Infra already built + tested. | verification-notes §60 |
| R1.6 macOS/Linux Ollama setup checklist | blocked on non-Windows hardware (unchanged). | wiki questions page |

**New since this batch (not loose ends — tracked features):**
- **Auto-resume on limit — REMOVED 2026-07-18 (Decision 37).** Phase 1 (detect + capture) was reverted and Phase 2 (auto-spawn) abandoned unbuilt: a proxy can't drive Claude Code's interactive TUI, and dedicated tmux-wrapper tools already cover unattended resume. The R5.1 durable task queue is unaffected.
- **R5.5 prompt-translation scoring loop** stays **deferred** (demand-gated per its debrief) — not unfinished work.

---

## Releases

Legend: 🔬 research/spike · 🧭 decision · 🔒 security/ToS gate · 🛠️ build

### R4 — Co-developer core — ✅ SHIPPED (2026-07-16)
Made goals 1 and 3 real: a planning-collaboration surface, a grounded,
measured, iterating local coder, and the last robustness gaps in the
distill/KB loop. (Batch brief retired to git history.)

| # | Task | Type | Source |
|---|---|---|---|
| R4.1 | ~~**Planning-collaboration surface:** `docs/plan/BACKLOG.md` ideas inbox + `/golem/plan` skill — reads `golem note` captures, wiki `questions/`, pending distill drafts, and this ROADMAP, then co-drafts task proposals with the user (plan-gated writes; approved tasks graduate into the ROADMAP/batch).~~ — **DONE** 2026-07-16: shipped `docs/plan/BACKLOG.md` (Date/Idea/Source/Status inbox, human-editable + plan-gated agent appends) and the `/golem/plan` skill (`src/cli/skills.ts`, installed by `golem init`): read-only gather of notes/`questions/`/distill drafts/BACKLOG/ROADMAP → grouped candidates → plan-gated proposals → cite-sources/flag-inference/admit-gaps contract. +4 unit tests, 890 green. See debriefs/2026-07-16-R4.1.md. | ✅ | Dec 36, Dec 20f |
| R4.2 | ~~**Coder grounding:** retrieval-augmented drafting — `coder` auto-injects relevant KB/wiki hits (size-capped, opt-out param) so local drafts stop being context-blind.~~ — **DONE** 2026-07-16: extracted a shared `assembleHits` (graph→vector→boost→rerank, reused by `search` and coder), added `gatherGrounding` (≤4 hits/≤4000 chars, `ground` opt-out + `project_id` inputs, `grounding:{sources,injected_chars}` in output, degrades to ungrounded on any failure). No frozen interface touched. +5 tests, 895 green. See debriefs/2026-07-16-R4.2.md. | ✅ | Dec 36 |
| R4.3 | ~~**Honest tool telemetry:** instrument `search`/`fetch`/`ingest`/`wiki_read`/`coder` with per-call events + a drafted-locally token bucket — closes the §59 gap so "token-friendly" is measured, not asserted.~~ — **DONE** 2026-07-16: new `kind:"tool"` telemetry event + `recordToolCall`/`aggregateToolUsage`; the 5 tools record duration/result-bytes (coder also model + drafted-locally chars) fire-and-forget; surfaced in the `stats` MCP tool (`tool_usage`) and `golem stats` ("local tools" section). No frozen interface touched. +6 tests, 901 green. See debriefs/2026-07-16-R4.3.md. | ✅ | §59, Dec 24 |
| R4.4 | ~~**Coder iteration loop:** optional draft → local-judge critique → revise pass (existing `drafter`/`judge` roles, no interface change); harden the `/golem/develop` skill around it.~~ — **DONE** 2026-07-16: `src/mcp/coder-refine.ts` `refineDraft` (judge critiques via forced-JSON verdict, drafter revises once on high/medium issues, best-effort fallback); `coder` gains `refine` (default off) + `refinement` output; `/golem/develop` hardened (grounding auto, refine for non-trivial, skip coder for tiny edits). No interface change. +9 tests, 912 green. See debriefs/2026-07-16-R4.4.md. | ✅ | Dec 35 |
| R4.5 | ~~**Distill-draft promotion UX + wiki-lint cleanup:** review/apply flow for `.golem/distill/` drafts (`golem wiki promote`-style), closing capture → distill → promote; plus fix the 18 pre-existing `golem wiki check` issues in dated pages (broken/missing wikilinks) and consider wiring the check into CI.~~ — **DONE** 2026-07-16: `golem wiki promote [id\|--list\|--yes]` (`src/cli/promote.ts`, append-and-refine upsert + draft consume, Decision 26 non-TTY refuse); checker now ignores code-fenced/inline wikilinks; all 18 lint issues fixed (17 link repairs + code-strip); `wiki check` wired into CI. `golem wiki check` → 0 issues. +9 tests, 921 green. See debriefs/2026-07-16-R4.5.md. | ✅ | WS-W W3 follow-up, Dec 36 debrief |
| R4.6 | ~~**`FileVectorDriver.#flush()` stream-write fix** so the raw-article KB can grow past ~30k chunks without crashing.~~ — **DONE** 2026-07-16: `#flush()` streams JSON lines via `createWriteStream` (backpressure-aware, atomic temp+rename kept) instead of one `Array.join` string; benchmark confirms 50k/60k no longer hit the `RangeError` wall (was 30k–50k), search latency unchanged. +1 test, 922 green. See debriefs/2026-07-16-R4.6.md. | ✅ | R3.7 spike |
| R4.7 | ~~**Drafter quality/catalog re-verification:** re-verify current best small coder models (advisory per Decision 6), measure coder draft accept-rate; carry R1.6's manual checklist where hardware allows.~~ — **DONE** 2026-07-16: re-verified catalog (no change — `qwen3-coder` ships only 30b/480b, no small tags; qwen2.5-coder still best for single-function drafts); measured ungrounded baseline 2 accept / 3 revise / 0 reject (accept for self-contained, revise for project-integrated); R1.6 still hardware-blocked. See verification-notes §63, syntheses/r4.7-drafter-quality-baseline.md. | ✅ | Dec 6, R1.6 |

### R5 — Autonomy & orchestration — ✅ SHIPPED (2026-07-16)
Formerly R4. Hold lifted 2026-07-16 by explicit user call; all five tasks landed
the same day (suite 922 → 1018 green). Retrospective:
`docs/wiki/syntheses/r5-autonomy-orchestration-batch.md` (the batch brief + design
memos were retired to git history). R5.4's threat model is ADR-0002.

| # | Task | Type | Source |
|---|---|---|---|
| R5.1 | ~~Durable task queue & auto-resume (persist prompt+agent+worktree, relaunch on capacity).~~ — **DONE** 2026-07-16: non-frozen `TaskStore` seam + file impl (`src/tasks/`, one zod JSON per task under `.golem/tasks/`), `golem task add/list/show/resume/cancel`. Resume mechanism verified as headless `claude -p --resume <session-id>` — no PTY (verification-notes §65). Capacity gate via `notBefore`; resume prints by default, `--spawn` opt-in (no shell). +25 tests, 977 green. See debriefs/2026-07-16-R5.1.md. | ✅ | 20a / WS-F1 |
| R5.2 | ~~Dashboard-as-sidecar completion (statusline + VS Code panel exist; add the shared session-state JSON API + `golem watch` TUI).~~ — **DONE** 2026-07-16: consolidated `SessionStateReport` + zod contract (`src/cli/session-report.ts`), `golem watch` full-screen TUI (hand-rolled ANSI, no deps, `src/cli/watch.ts`), `.golem/` storage sizing (`src/cli/storage-size.ts`), dashboard `/api/state` endpoint. No frozen interface touched. +14 tests, 952 green. See debriefs/2026-07-16-R5.2.md. | ✅ | 21c / WS-F10 |
| R5.3 | ~~Task/question queue + local conversation multiplexing.~~ — **DONE** 2026-07-16: `src/tasks/multiplex.ts` — `serviceTaskLocally` (fail-open), `runQueueLocally` (bounded concurrency, stops early if Ollama down), explicit `escalateTask` (folds local result → Claude tier, 21a, never silent). `golem task run` / `task escalate`. +8 tests, 1012 green. Grounding-injection into `run` is a follow-up. See debriefs/2026-07-16-R5.3.md. | ✅ | 20b/21a |
| R5.4 | ~~Cruise-control autonomy modes with approval gates.~~ — **DONE** 2026-07-16: threat model written first (ADR-0002); `src/autonomy/` (levels manual/assisted/outcome, conservative classifier, gate) + `PreToolUse` hook (`golem hook pre-tool-use`) + `golem autonomy show/set/wire/unwire/log`. Default-deny/fail-closed proven — never auto-approves destructive/outward, errors → native prompt. Opt-in (not auto-wired by init); surfaced in the R5.2 report. +27 tests, 1004 green. See debriefs/2026-07-16-R5.4.md. | ✅ | 20d / WS-F4 |
| R5.5 | ~~Writing-style adaptation & prompt translation (local-LLM, fully inspectable).~~ — **DONE (spike)** 2026-07-16: `src/prompt/` — `translatePrompt` (local rewrite, always shown/never sent/off proxy path, few-shot on accepted examples), `golem prompt translate/accept`. Scoring loop deliberately NOT built — demand-gated (see debrief). +6 tests, 1018 green. See debriefs/2026-07-16-R5.5.md. | ✅ | 20g |

### R6 — Multi-provider & remote — ⛔ ON HOLD (security/ToS-gated)
Formerly R5. Same hold + per-task design-memo gate as R5; R6.3 is the
Decision 21b **companion app** the user has explicitly deferred.

**Design memos written (2026-07-23, PROPOSED — no code):**
`docs/plan/proposals/r6-multi-provider-remote-memos.md` covers R6.1/R6.2/R6.4
(R6.3 excluded per the user's deferral). Each stays PROPOSED until its
`verification-notes.md` pass + 🔒 gates clear + a separate explicit build ask.
Recommended order: R6.4 (no gate) → R6.1 case (a) → R6.1 case (b) → R6.2 (after
R6.1 + ToS review + a credential threat-model ADR). **R6.4 shipped 2026-07-23**
(`golem bench cost`); R6.1/R6.2 remain PROPOSED.

| # | Task | Type | Source |
|---|---|---|---|
| R6.1 | Provider-agnostic adapters (front Foundry/OpenRouter; Anthropic byte-faithful path untouched). Positioning-unblocked by Decision 32. **Case (a) — Anthropic-native gateways: DONE 2026-07-23** (`upstream_provider`/`upstream_auth_scheme` config + `src/providers/` auth-header mapping + `mapUpstreamHeaders` proxy seam + `assumeCachingUpstream` fix for Claude-via-Azure; verification-notes §73; live-unverified — no real gateway creds in-session). **Case (b) — OpenAI/Gemini/Ollama-LAN translation + response-transform seam: b1 DONE 2026-07-23** (non-streaming Anthropic↔OpenAI translation + `translateUpstream` proxy seam; providers `openai`/`ollama` + `proxy.upstream_model`; **live-verified against local Ollama** `qwen2.5-coder:7b`, verification-notes §74). **b2 (SSE streaming) DONE 2026-07-23** (`OpenAIChatSSETranslator` OpenAI-deltas→Anthropic-events; proxy streams it live; request honors `stream:true`; **live-verified vs Ollama**, verification-notes §75). **b3 (tool-use) DONE 2026-07-23** (`tools`/`tool_choice` + `tool_use`↔`tool_calls` + `tool_result`↔`role:tool`; non-streaming + streaming `input_json_delta`; unit-verified — a local model that emits native tool_calls needed for live, verification-notes §76). **OpenAI functional 2026-07-23** (no new code — the b1–b3 translator + the `openai` provider: set `upstream_base_url`/`upstream_model` + `GOLEM_UPSTREAM_API_KEY`; also live-verifies b3's tool path since OpenAI emits native `tool_calls`). **b4-gemini DONE 2026-07-23** (Gemini `generateContent` translator — request/response/streaming/tools + `geminiPath`; seam extended with a per-request path override for query-param `?key=` auth + `alt=sse`; provider `gemini` wired; unit- + proxy-integration-verified; **not live-tested** — no Gemini key in-session, §77). **Case (b) complete: OpenAI, Ollama (LAN), Gemini.** | 🧭🛠️ | Dec 22/32 |
| R6.2 | Account switching + multi-LLM/quota routing. **Threat-model ADR drafted 2026-07-23** (`decisions/ADR-0003`, PROPOSED): credential storage (env-var-first, secrets never a setting, fail-closed, audit log) + ToS scope (legitimate account/provider switching IN; automated quota-evasion OUT). **Still gated: needs the USER's ToS scope decision + ADR acceptance before code.** | 🔒 | 21d/21e |
| R6.3 | Remote steering / permission-granting — companion app + locally-hosted web (self-hosted relay, mTLS, default-deny on link loss). | 🔒🔬 | 20c/21b |
| R6.4 | ~~Cost-governance benchmarks vs Claude's cost doc (continuous once picked up).~~ — **DONE (first cut)** 2026-07-23: `golem bench cost [--window 24h\|7d\|all] [--project] [--json]` composes existing telemetry (R1.1 net-of-cache `usage`, R2.2/R2.3 `avoidedUpstream`, CCR activity, R4.3 per-tool events) into a report framed against the re-verified cost-doc baselines (verification-notes §72) — honestly scoped (Golem's own contribution, not a `/usage` replacement; baselines are reference, not a claimed delta) + a CLAUDE.md-leanness check. Pure `buildCostBenchmark` + `readTelemetryEvents` reader; no frozen-interface change, no proxy-path change. +11 tests, 1170 green. See debriefs/2026-07-23-R6.4.md. | ✅ | 21f |

### R7 — Distribution, versioning & self-update — ✅ SHIPPED (2026-07-22 → 07-23); R7.5 USER-gated
The golem.run onboarding one-liner + how installs stay current (spec Decision 41,
verification-notes §70). npm-first, Bun standalone as the no-Node fallback.
R7.1–R7.4 landed across PRs #21 (install one-liner + version SoT + self-update)
and #22 (tag-triggered Release workflow), with follow-up status-surface hardening
in #20/#25/#26/#27/#28. Retrospective: `docs/wiki/debriefs/2026-07-22-decision-41-distribution.md`
+ `2026-07-23-statusline-golem-dir-gating.md`. **R7.5 (first publish) stays
deferred to the user** — machinery is in place; the `v0.1.1` tag exists but
`golem-run` is still unpublished (npm 404).

| # | Task | Type | Source |
|---|---|---|---|
| R7.1 | ~~Version single source of truth — `sync-version.mjs` → `src/version.ts` from `package.json`; `release.mjs` bumps both package.jsons in lockstep.~~ — **DONE** (#21, Dec 41a): `sync-version.mjs` wired into `npm run build`; `release.mjs` bumps root + `vscode-extension/package.json` in lockstep; `RELEASING.md` shipped. | ✅ | Dec 41a |
| R7.2 | ~~Tiered install scripts (`install/install.sh` + `.ps1`, npm→binary→Node bootstrap) + nginx UA-sniffing config (`deploy/nginx/golem-run.conf`).~~ — **DONE** (#21, Dec 41b/41c): both installers run the npm→binary→(opt-in) Node-bootstrap ladder and degrade gracefully while unpublished; `golem-run.conf` maps PowerShell/curl/browser UAs (PS matched before the generic Mozilla rule). Standing up the nginx host + confirming the UA map is a USER infra step. | ✅ | Dec 41b/41c |
| R7.3 | ~~Standalone binary via `bun build --compile` (`scripts/build-binary.mjs`) + CI release workflow.~~ — **DONE (build-wired)** (#22, Dec 41d): cross-compile script + tag-triggered Release workflow shipped. **Binaries still unverified per-OS** (no Bun/mac/linux in-session; and CI itself is billing-blocked) — the 🔬 smoke-test remains, verification-notes §70. | 🔬 | Dec 41d |
| R7.4 | ~~Self-update: `golem update [--check --json]` (install-method aware) + `updateAvailable` in status/statusline + extension status-bar badge & `golem.update`.~~ — **DONE** (#21, Dec 41e; hardened in #20/#25/#26/#27/#28): install-method-aware `golem update`, cached/offline-tolerant check surfaced in status/statusline + VS Code badge; follow-ups fixed the `.golem/` footprint leaks in non-Golem projects and the Passthrough off-state label. | ✅ | Dec 41e |
| R7.5 | First `npm publish` + Marketplace publish + tag `v0.1.0` (USER-triggered; machinery + `RELEASING.md` shipped, publish deferred to the user). **Still pending — `v0.1.1` tagged locally, npm 404 (unpublished).** | 🚀 | Dec 41 |

---

## Concentrated decision/research backlog

Most earlier gates have cleared: **R4.7 drafter quality** shipped (baseline
measured, 2026-07-16), **Decision 33 local-answer** flipped to ACCEPTED
(2026-07-17), and **R5.4 autonomy** shipped (2026-07-16, refined by Decision 40).
What remains:

1. **🔒 All of R6** (multi-provider adapters, account/quota routing, remote
   steering + companion app, cost benchmarks) — on hold. Design memos for
   R6.1/R6.2/R6.4 are now written (`proposals/r6-multi-provider-remote-memos.md`,
   PROPOSED); each still needs its verification pass, 🔒 gates, and a separate
   explicit build ask before code. R6.3 remains deferred (needs its own
   threat-model ADR, not just a memo).
2. **🔬 R7.3 standalone-binary verification** — the Bun `--compile` binaries are
   build-wired but never run per-OS (no Bun/mac/linux in-session; CI itself is
   billing-blocked). Smoke-test each before relying on the binary channel.
3. **🚀 R7.5 first publish** (USER) + the golem.run nginx host stand-up (USER) —
   machinery shipped; the outward, credentialed acts are the user's.

## Deferred / not scheduled

The **hosted workspace/org knowledge tier** (WS-F5's upper tiers — P4+,
candidate paid) remains the only work off the roadmap entirely. The WS-F↔
ROADMAP crosswalk lives in `IMPLEMENTATION_PLAN.md` §6; the full spec rationale
is the Decisions Log (`docs/golem-spec.md`, Decisions 20–36).
