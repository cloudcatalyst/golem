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
  intercept, slider levels 0–5 (WS-D); wiki W1–W3 (WS-W); file watcher (T6).
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
the §31 artifact.

| # | Task | Type | Source |
|---|---|---|---|
| R2.1 | Decision 24 spike: measure real `avoidedUpstream` token volume from proxy-side KB/web-cache answer substitution. | 🔬 | Dec 24 |
| R2.2 | Build context-substitution (conservative sub-mode) behind the compression seam + `avoidedUpstream` telemetry bucket, if R2.1 clears. | 🛠️ | Dec 24 |
| R2.3 | Local-answer sub-mode contract + recorded-shape tests (proxy-as-responder), reusing the Decision 25 precedent. | 🛠️🔒 | Dec 24 |
| R2.4 | Fix the `expand`↔Headroom-CCR gap: content Headroom elides at ≥3 is unrecoverable via `expand`. | 🛠️ | §38 |

### R3 — Knowledge depth
Make the KB/wiki genuinely strong now that the retrieval spine exists.

| # | Task | Type | Source |
|---|---|---|---|
| R3.1 | Rerank — cross-encoder or chat-judge rerank at slider ≥3 (needs a new optional reranker surface; frozen `InferenceService` has no `rerank`). | 🧭🛠️ | §29 |
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
| R5.1 | Provider-agnostic adapters (front Foundry/OpenRouter; Anthropic byte-faithful path untouched). Blocked on R1.2. | 🧭🛠️ | Dec 22 |
| R5.2 | Account switching + multi-LLM/quota routing. | 🔒 | 21d/21e |
| R5.3 | Remote steering / permission-granting (self-hosted relay, mTLS, default-deny on link loss). | 🔒🔬 | 20c/21b |
| R5.4 | Cost-governance benchmarks vs Claude's cost doc (continuous). | 🛠️ | 21f |

---

## Concentrated decision/research backlog

The gates that block downstream work, in priority order:

1. **🧭 Positioning (R1.2)** — golem.run copy and whether R5.1 is worth building both hang on the assistant-vs-universal-processor call.
2. **🔬 Net-of-cache A/B (R1.1)** — cheap to run (sidecar + real transcript exist); de-risks the whole compression story and unblocks any savings claim.
3. **🔬🧭 Decision 24 (R2.1)** — `avoidedUpstream` is plausibly the only real big-savings lever on cached Anthropic traffic.
4. **🧭 Rerank surface (R3.1)** — touches the design of an optional inference surface (frozen-interface adjacent).
5. **🔒 R4.4 + all of R5** — autonomy, account-switching, remote approval each need a written memo + review before code.

## Deferred / not scheduled
Everything in `IMPLEMENTATION_PLAN.md` §7 not pulled into R4/R5 above stays
design-memo-gated. The full spec rationale for each lives in the Decisions Log
(`docs/edge-offload-spec.md`, Decisions 20–29).
