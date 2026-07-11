# Golem Roadmap (post-P0/P1)

> **Written 2026-07-11** by a revalidation session. This is the durable,
> multi-release view that sits above `IMPLEMENTATION_PLAN.md` (workstreams,
> frozen interfaces) and whatever the current actionable batch file is
> (`R1_BATCH.md` at time of writing). When a release's work is picked up, spin
> its tasks into a batch brief in the style the repo already uses; when it
> lands, mark it here and move on.

## Where we are (validated 2026-07-11)

- **Baseline green:** `tsc --noEmit`, `biome check`, and `vitest run`
  (77 files / 728 tests) all pass on this machine.
- **P0 shipped:** proxy + redaction + native lossless + telemetry (WS-A),
  unified MCP server + 8 tools (WS-B), CLI + `init`/`uninit` + VS Code
  extension + statusline (WS-E).
- **P1 largely shipped:** zero-setup KB with a pure-TS hashing embedder and a
  durable `FileVectorDriver`, semantic upgrade to `bge-m3` when Ollama is
  present (WS-C); capability detection + Ollama bootstrap + local-drafter
  intercept, slider levels 0–3 (WS-D, simplified by Decision 30); wiki W1–W3 (WS-W); file watcher (T6).
- **The prior batch (`NEXT_BATCH.md`, tasks T1–T7) is fully landed** — telemetry
  `ccrRefsRetrieved`, wiki skills, distillation engine, `golem note`,
  graph-first search, file watcher, and the entropy/path redaction fix.

## The strategic finding that shapes everything below

`verification-notes.md` §30–§35 + spec **Decision 23** re-based the token-savings
thesis on measured evidence: native lossless compression saves **≈0%** on cached
Anthropic traffic, heuristic Headroom **~5.3%**, and the ML tier **<1%** on code
traffic. **No net-of-cache savings number has ever been measured live.** Until it
is (R1.1), Golem cannot honestly headline any savings figure, and the lead
positioning is redaction + local tools + routing + honest observability, with
compression demoted to *situational* (non-caching upstreams). R2 is the search
for the real lever; it is gated on R1.1's measurement rigor.

---

## Releases

Legend: 🔬 research/spike · 🧭 decision · 🔒 security/ToS gate · 🛠️ build

### R1 — Honest baseline (ship-readiness)
Make the current build correct, measured, and honestly positioned before any
public/golem.run push. No new architecture. **Active batch: `R1_BATCH.md`.**

| # | Task | Type | Source |
|---|---|---|---|
| R1.1 | Net-of-cache A/B: real billed `cache_read` vs uncached tokens, ± Headroom sidecar, on live traffic. Hard gate for every savings claim. | 🔬 | §34.3, §36, Dec 23 |
| R1.2 | Positioning decision: assistant-for-Claude vs universal pre-LLM processor; update golem.run copy to the evidence-based framing. | 🧭 | Dec 22/23 |
| R1.3 | Redaction: credit-card false-positive on sparse digit runs (Luhn on space/dash-separated small numbers). T-C3-gated. | 🛠️🔒 | §50 |
| R1.4 | Redaction: provider-rule gaps — Google `AIza`, Stripe `sk_live_`, GCP `ya29.`, Azure conn-strings. | 🛠️🔒 | §24 |
| R1.5 | Plan housekeeping: mark shipped work in `IMPLEMENTATION_PLAN.md`; syntheses wiki page (plan-gated); retire the old batch file. | 🛠️ | NEXT_BATCH §5 |
| R1.6 | macOS + Linux manual Ollama-setup verification (the §48 checklist rows still unrun). | 🔬 | §48 |
| R1.7 | T-C2 cross-OS e2e smoke in CI + verify Linux recursive `fs.watch` reliability (else fall back to chokidar per ADR-0001). | 🛠️🧭 | §51, T-C2 |

### R2 — Real savings, evidence-gated
The actual big-savings levers. Every build here is gated on R1.1 — no repeat of
the §31 artifact. **Active batch: `R2_BATCH.md`.**

| # | Task | Type | Source |
|---|---|---|---|
| R2.5 | ~~**Verify** whether Headroom can disable `read_lifecycle`~~ — **DONE** 2026-07-11 (verification-notes §58): possible but not the right lever; the cache-risky half is already off by default; the library's real cache-safe mechanism (read maturation) is proxy-only, out of reach for Golem's sidecar. | 🔬 | §53, §58, Dec 31 |
| R2.6 | ~~Build the **cache-safe structural tier**~~ — **⚠️ PARTIAL** 2026-07-11 (verification-notes §60): opt-in `force_semantic_on_caching` bypass + `aggregateUsageBySemanticForced`/`semanticForcedReportRows` A/B infra shipped and tested; live real-traffic A/B deliberately deferred (would require restarting the dogfooded proxy mid-session). Gate defaults OFF pending that follow-up. | 🛠️ | §58, §60, Dec 31 |
| R2.1 | ~~Decision 24 spike: measure real `avoidedUpstream` token volume~~ — **DONE** 2026-07-11 (verification-notes §59): no telemetry exists yet for KB-answer substitution itself (`search`/`fetch`/`ingest`/`wiki_read` uninstrumented); the one real proxy signal (CCR retrieval rate, 0 misses/1051 stores) is encouraging but indirect. R2.2 to ship its own bucket. | 🔬 | Dec 24 |
| R2.4 | ~~Fix the `expand`↔Headroom-CCR gap~~ — **DONE** 2026-07-11 (verification-notes §61): confirmed Headroom's `hash=` markers are reproducible SHA-256/MD5-prefix digests of the elided content; `backfillHeadroomCcrRefs` backfills Golem's own CCR store under that hash so `expand` recovers it, no marker-text changes. | 🛠️ | §38, §61 |
| R2.2 | ~~Build context-substitution (conservative sub-mode) behind the compression seam + `avoidedUpstream` telemetry bucket~~ — **DONE** 2026-07-11 (verification-notes §62): shipped as pipeline Stage 4, gated by the existing `semanticCompression !== "off"` slot (Decision 24's "old ≥3" translates to new levels 2-3) + the Decision-31 non-caching-upstream gate; webcache-only v1 scope; new `avoidedUpstream` telemetry bucket (`recordAvoidedUpstream`/`aggregateAvoidedUpstream`). | 🛠️ | §62, Dec 24 |
| R2.3 | ~~Local-answer sub-mode contract + recorded-shape tests (proxy-as-responder)~~ — **DONE** 2026-07-11 (Decision 33, PROPOSED): new frozen `LocalAnswerService` contract + `ProxyRequest.respondDirectly` seam, single-turn/extractive/confidence-gated, decoupled from the slider, opt-in and off by default. Contract/unit/integration tests all green (86 files, 809 tests). Pending human review of a real served answer before flipping to ACCEPTED. | 🛠️🔒 | Dec 24 |

**R2 batch complete** 2026-07-11 (R2.5, R2.6⚠️partial, R2.1, R2.4, R2.2, R2.3
all landed) — see `R2_BATCH.md`. **Active batch: `R3_BATCH.md`.**

### R3 — Knowledge depth
Make the KB/wiki genuinely strong now that the retrieval spine exists.

| # | Task | Type | Source |
|---|---|---|---|
| R3.1 | Rerank — cross-encoder or chat-judge rerank at slider ≥2 (needs a new optional reranker surface; frozen `InferenceService` has no `rerank`). | 🧭🛠️ | §29 |
| R3.2 | Real HTML/PDF-text extractor (`.html/.rst/.pdf` currently route through the plain text chunker). | 🛠️ | §27 |
| R3.3 | tree-sitter (WASM) opt-in syntax-aware code chunker, behind the KB add-on. | 🛠️ | §27 |
| R3.4 | W4 — user-scope `~/.golem/wiki/` federation + weekly synthesis reports. | 🛠️ | WS-W W4 |
| R3.5 | note→distill shaping — shape `golem note` captures into draft `questions/artifacts/` pages. | 🛠️ | T3 debrief |
| R3.6 | C4 — MEMORY-scope federated search (requires the P2 Headroom Python sidecar). | 🛠️ | C4 |
| R3.7 | LanceDB scale driver (optional; only pays at 10⁵⁺ vectors). | 🧭 | §26/§39 |

### R4 — Autonomy & orchestration (each needs a design memo first)
The WS-F cluster where dogfooding hurt most (losing in-flight work to limits).

| # | Task | Type | Source |
|---|---|---|---|
| R4.1 | Durable task queue & auto-resume (persist prompt+agent+worktree, relaunch on capacity). | 🔬🛠️ | 20a / WS-F1 |
| R4.2 | Dashboard-as-sidecar completion (statusline + VS Code panel exist; add the shared session-state JSON API + `golem watch` TUI). | 🛠️ | 21c / WS-F10 |
| R4.3 | Task/question queue + local conversation multiplexing. | 🔬🛠️ | 20b/21a |
| R4.4 | Cruise-control autonomy modes with approval gates. | 🔒🛠️ | 20d / WS-F4 |
| R4.5 | Writing-style adaptation & prompt translation (local-LLM, fully inspectable). | 🔬 | 20g |

### R5 — Multi-provider & remote (security/ToS-gated, furthest out)

| # | Task | Type | Source |
|---|---|---|---|
| R5.1 | Provider-agnostic adapters (front Foundry/OpenRouter; Anthropic byte-faithful path untouched). Unblocked by Decision 32 (R1.2, 2026-07-11) — not yet scheduled; starting the build still needs a separate ask per R1_BATCH.md §3's WS-F* gate. | 🧭🛠️ | Dec 22/32 |
| R5.2 | Account switching + multi-LLM/quota routing. | 🔒 | 21d/21e |
| R5.3 | Remote steering / permission-granting (self-hosted relay, mTLS, default-deny on link loss). | 🔒🔬 | 20c/21b |
| R5.4 | Cost-governance benchmarks vs Claude's cost doc (continuous). | 🛠️ | 21f |

---

## Concentrated decision/research backlog

The gates that block downstream work, in priority order:

1. ~~**🧭 Positioning (R1.2)**~~ — **RESOLVED** 2026-07-11 (Decision 32): universal pre-LLM processor, R5.1 unblocked. golem.run copy revised.
2. ~~**🔬 Net-of-cache A/B (R1.1)**~~ — **RESOLVED** 2026-07-11 (verification-notes §54): levels 1/3 pipeline-identical on Anthropic today; no live A/B signal there until the §53 cache-safe structural tier lands.
3. **🔬🧭 Decision 24 (R2.1)** — `avoidedUpstream` is plausibly the only real big-savings lever on cached Anthropic traffic.
4. **🧭 Rerank surface (R3.1)** — touches the design of an optional inference surface (frozen-interface adjacent).
5. **🔒 R4.4 + all of R5** — autonomy, account-switching, remote approval each need a written memo + review before code. R5.1 is positioning-unblocked (Decision 32) but still needs that memo + an explicit go-ahead before build starts.

## Deferred / not scheduled
Every WS-F workstream (`IMPLEMENTATION_PLAN.md` §7), plus WS-C C4 and WS-W W4,
is now scheduled as a task above (R3–R5) — see §7's WS-F↔ROADMAP crosswalk; they
are no longer a separate backlog. The **only** work still off the roadmap is the
**hosted workspace/org knowledge tier** (WS-F5's upper tiers — P4+, candidate
paid). Each scheduled item still carries its own gate (design memo, security/ToS
review, or explicit go-ahead) noted on its task; the full spec rationale lives in
the Decisions Log (`docs/edge-offload-spec.md`, Decisions 20–29).
