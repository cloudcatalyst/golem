---
title: WIKI
type: schema
tags: [meta]
sources: []
created: 2026-07-10
updated: 2026-07-30
---

# Golem project wiki — schema (Zone 0)

This directory is the project's durable knowledge store (spec Decision 28):
human-readable, committed to git, and the **first port of call** for Claude before
vector search or the outside world. The vector index under `.golem/knowledge` is a
derived, rebuildable cache of these pages — never the truth.

## Zones and write rules

| Zone | Where | Who writes | Rule |
|---|---|---|---|
| 1 — raw | `.golem/webcache`, `.golem/ccr` (local, gitignored) | Golem hooks | never committed; never hand-edited |
| 2 — wiki | `concepts/ entities/ sources/ syntheses/ questions/ artifacts/ debriefs/` | agent + human | **author freely** — create or refine pages without prior approval (spec Decision 44). Every write is committed to git, so it is diffable, reviewable, and revertible in history. Prefer append-and-refine over wholesale rewrites. |

> **Decisions (ADRs) live at `docs/decisions/`, outside this wiki** (spec Decision 44).
> They are human-driven dev artifacts with a stricter rule — accepted ADRs are
> immutable except status; superseded, never deleted — so they sit apart from the
> freely-authored wiki. `docs/golem-spec.md` remains authoritative for this
> project's own Decisions Log.

Hard rules for every write, agent or human (these still bind — de-gating is not a licence to skip them):

1. **Redaction before storage** — no secrets/PII ever land here (repo hard rule).
2. **Link, don't restate.** The wiki never duplicates what the code, `docs/`, or git
   history already record — link to the file/spec section instead. For this repo,
   `docs/golem-spec.md` stays authoritative for decisions.
3. **No raw fetched full-text.** Fetched pages live in the webcache (zone 1); what
   goes here is a distilled source note in our own words, citing the URL.
4. **Contradictions are reported to the human, never auto-resolved.**

## Page conventions

- Filenames: Title Case for `concepts/` and `entities/` (`Prompt Caching.md`);
  kebab-case slugs for `sources/`, `syntheses/`, `questions/`, `artifacts/`;
  `YYYY-MM-DD-slug.md` for debriefs. (ADRs — `ADR-NNNN-slug.md` — live outside
  this wiki at `docs/decisions/`, spec Decision 44.)
- Links: wikilinks (`[[Page Title]]`) between wiki pages; plain repo-relative paths
  for code/docs. Every page carries **at least one wikilink**.
- Required frontmatter on every page:

```yaml
---
title: Page Title
type: concept | entity | source | synthesis | question | artifact | adr | debrief
tags: [kebab-case]
sources: [urls or repo paths]   # where this knowledge came from
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

- Format is Obsidian-compatible on purpose, but nothing may depend on Obsidian.

## Index

- [[Architecture]] — **visual map**: component topology, proxy request lifecycle, local/LAN/upstream routing, observability, and the PreToolUse guardrail stack (Mermaid diagrams, the deep-dive entry point)
- [[Wiki-First Knowledge]] — the pattern this wiki implements
- [[Guidance Rules]] — how Golem's working practices are stored as Claude Code `.claude/rules/golem-*.md` (seeded by init, toggled by `golem guidance`)
- [[Configuration Surfaces]] — one control surface (settings + guidance + runtime) behind the `golem` panel, `golem config`, and the VS Code webview; compile-enforced setting metadata, the pet, env-locked rows
- [[Cache Observability]] — R8.1: prompt-cache hit rate + prefix-bust detection (`golem stats --cache`); two signals (billed = authoritative, verdict = prediction) never merged; **measured 98.4% hit rate on this repo, which demoted bust-prevention to a guard rail** (§93)
- [[Managed Tools]] — spec Decision 53: external tools are **spawned or detected, never shipped**; the tier ladder (1/2/3a/3b), the three integration shapes, the admission bar, and `golem ext` (which refuses to claim "running" and says why instead)
- [[Redaction Stage]] — rule table, entropy heuristic, known false-positive classes
- [[Slider Levels]] — the 0–3 compression dial; level 0 = passthrough (redaction OFF, Decision 30); slider never engages the local model (Decision 31)
- [[Compression]] — situational savings (Decision 23): lossless/CCR always pays, lossy semantic only on non-caching upstreams (~0% on Anthropic cached)
- [[Repo Map]] — R8.5: whole-repo signature skeleton, graph-ranked and budgeted (`code` tool, `mode: "map"`) plus the symbol skeleton on an oversized `Read`; **measured +21.4 accuracy points for +57 tokens** against a plain path list (§101), byte-stable so it is cache-safe
- [[LSP Bridge]] — R8.6: `diagnostics`/`definition`/`references`/`hover` as MODES of the `code` tool, answered by a language server the USER installed; **+333 definition tokens when enabled, zero when off**, every wait bounded, and every absence a no-op rather than an error (§109)
- [[Change Ledger]] — R8.9: `golem checkpoint` snapshots the worktree to a **shadow git ref** (`refs/golem/ledger/*`) so a failed attempt can be DISCARDED instead of repaired; never a commit on your branch, never the index (throwaway `GIT_INDEX_FILE`), restore is human-gated *and* itself undoable, and no MCP tool — the guidance is a skill, because a definition bills every request
- [[Tool Search]] — Anthropic's on-demand tool loading (GA): defer_loading sends full defs but keeps them out of the cached prefix; why Golem relays it rather than shrinking the tools block itself
- [[Web Cache]] — WebFetch fetch-cache-serve flow (Decision 42 raw mode), freshness/revalidation, oversized → CCR ref
- [[Knowledge Base]] — RAG ingest + graph-first-then-vector search, scopes/federation, FileVectorDriver (vs spec's Qdrant)
- [[Distillation Pipeline]] — capture -> distill -> promote data flow (capture + distill built, T4/T3)
- syntheses/wiki-knowledge-loop-batch.md — retrospective tying the T1–T7 batch + init-guidance work into one knowledge loop; records patterns + open follow-ups
- sources/llm-wiki-second-brain-obsidian.md — distilled source note for the
  originating article
- sources/local-coder-models-2026.md — distilled landscape of small local coder models (Qwen3-Coder vs Qwen2.5-Coder; Ollama tag availability), captured during R4.7
- sources/kimi-k3.md — Kimi K3 (Moonshot) API: OpenAI-compatible (base `https://api.moonshot.ai/v1`, model `kimi-k3`, bearer); fronted via Golem's `openai` provider + the reasoning/vision translator support (R6.1 b4-kimi)
- sources/agentic-token-saving-techniques.md — four families of agentic token-saving (caching, lazy tool-def loading, routing/cascading, compaction) mapped to Golem's stance; names the honest gaps (lazy tool-defs, cache-hit observability)
- `questions/` — open questions carried over from the Decision 28 proposal
- debriefs/2026-07-10-T7.md — entropy sweep path false-positive fix
- debriefs/2026-07-10-T1.md — wired durable `ccrRefsRetrieved` telemetry
- debriefs/2026-07-10-T2.md — shipped the missing `wiki-query`/`wiki-ingest` skills
- debriefs/2026-07-10-T4.md — shipped `golem note` capture (spec Decision 20f)
- debriefs/2026-07-11-T5.md — graph-first lookup ahead of vector search in `search`
- debriefs/2026-07-11-T3.md — distillation engine + lazy webcache distill (`golem wiki distill`)
- debriefs/2026-07-11-golem-init-guidance.md — baked wiki-promotion + local-model-first practices into the `golem init` guidance template
- debriefs/2026-07-30-control-panel-and-config-surfaces.md — the `golem` control panel + the one control surface behind CLI/TUI/VS Code; why the config layering needed no refactor, only metadata
- debriefs/2026-07-30-r8.5-repo-map.md — R8.5: the first item in the R8 context-economy line its own instrument APPROVED (`golem bench map`: 28.6% → 50.0% retrieval accuracy for +57 tokens/call, 22 cases × 3 repeats); three ranking bugs found by reading real output (exported-only graph targets, damping + affinity for a queried map, word-part/IDF matching instead of substrings); displacement (memo open question 3) still unmeasured
- debriefs/2026-07-30-r8.4-context-ledger.md — R8.4: `golem stats --context` attributes every token in the outgoing request to a bucket and resolves `tool_result` blocks back to the producing tool; first capture found the `tools` block at **18,827 tokens** (~5× §88's figure, promoting schema shrinking), Bash the biggest tool consumer at 36,968 across 132 results (quantifying the RTK case), and one `expand` costing 6,356
- debriefs/2026-07-30-r8.1-cache-observability.md — R8.1: `golem stats --cache` (billed hit rate + prefix-bust verdicts); the instrument's first measurement (98.4% hit rate, uncached input 0.06%) demoted its own bust-detection half to a guard rail and promoted the context-shrinking levers
- debriefs/2026-07-31-headroom-net-gate.md — the Headroom net gate closed offline: NET 8.7x–11.3x WORSE on caching traffic (§103), and `golem status`/statusline were reporting the nominal compression level instead of the effective one
- debriefs/2026-07-31-r8.13-cache-verdict-fix.md — R8.13: the verdict half was 98% wrong because `cache_control` (a breakpoint *marker*, not content) was in the fingerprint — §99's "colliding conversation key" hypothesis disproved by recording one more number (the bust index, always `prevCount-1`); 0% → 73% append, and surviving busts now bill 3.3x the cache write of an append; adds a `lookback` bust component for Anthropic's documented 20-block window
- debriefs/2026-07-31-park-locality-precedence.md — three `S` honesty fixes: the snooze park procedure's first step (`golem task add`) was denied by its own second step under Decision 45, fixed by folding the note INTO the `snooze` tool (structurally impossible, not exempted); `golem devices`/`golem local status`/the `devices` MCP tool now report per-role **pulled / not-pulled / unknown** against `/api/tags` instead of presenting the tier catalog as an inventory (the gap that cost the LE2 judge bug, §89 and §100), with the availability warning moved *before* the benchmark run; and §91's undocumented PreToolUse precedence closed on both halves (§105) — the docs now state `deny > defer > ask > allow`, and a live opt-in test against Claude Code 2.1.220 proves a `deny` still discards a peer hook's `updatedInput` rewrite
- debriefs/2026-07-31-r8.8-model-catalog.md — R8.8: per-model price and context limits as Golem's own cached data (§106) — `golem bench cost` reports real money, `golem stats --context` checks the window, `golem models list|refresh`; models.dev's WEB table shows several Anthropic models at $0.00 while its JSON API is correct, so the built-in dated table always beats the fetched one and nothing fetches implicitly; every "cannot price this" case stays visible (unattributed / unpriced / ambiguous / provider-unconfirmed); the telemetry allow-list dropped the new fields for the THIRD time (R8.1, R8.13, now `model`)
- debriefs/2026-07-31-p3b-caveman-shrink.md — P3b: Golem's existing tools gate pointed at `caveman-shrink`'s own implementation instead of rebuilding it (§107) — 53 of 1,089 description tokens (4.9%), accuracy unchanged, so a reproducible negative; resolved from the USER's install with absence as a hard refusal (an identity transform would publish a fake 0% under their name); also documents the install/config surface §87 could not find on their README
- debriefs/2026-07-31-r8.s2-system-prompt-slimming.md — R8.S2: declined with the arithmetic (§108) — the system prompt is 3,347 tokens = 0.92% of a 362k request, a 30% trim collects 0.205% of input cost (~$22/month) and one busted prefix costs 6.7x a request = 3,247x the saving; declined on ownership as much as size, the fourth input-side idea to die on "whose bytes are they, and how big is the prize"
- debriefs/2026-07-31-r8.6-lsp-bridge.md — R8.6: the LSP bridge shipped as four MODES of the existing `code` tool (`diagnostics`/`definition`/`references`/`hover`), not four tools — measured +333 full-definition tokens when enabled versus the ~250-320-token envelope four separate tools would each pay, and **zero when off** (the schema only grows when `knowledge.lsp_enabled` injects the bridge; the default census is 22 tokens cheaper than before); tier-2 spawn of the user's own `typescript-language-server`, every wait bounded, and 17 tests against a fake server prove every degrade path (absent binary, unclaimed extension, handshake/request timeout, mid-session crash, protocol desync) resolves to `available: false` rather than throwing (§109)
- debriefs/2026-07-31-r8.7-local-editor.md — R8.7: `coder` gains `mode: "edit"` — the local model rewrites one small file and **Golem validates it** — but the harness came first and rejected two of the three designs: `search-replace` **33.3%** semantic (half the replies were not even in the format) and `udiff` **33.3%** (perfect compliance, half the hunks unmatchable — the model paraphrases lines it was told to copy), against **whole-file 91.7% semantic / 100% apply** (§110); validation gained a **definition-loss guard** for the whole-file failure a parse check cannot see; +313 definition tokens when on, **byte-identical to R8.6 when off** (`inference.local_editor_enabled`, default false), and the fixture-scale arithmetic (~30 output tokens saved per edit) honestly does NOT repay that — the claim is conditional on bigger edits; `--repeats` proven useless at temperature 0 (only more cases sharpen the instrument)
- debriefs/2026-07-31-r8.9-change-ledger.md — R8.9: `golem checkpoint` over shadow refs, so a failed attempt is discarded rather than repaired; shadow refs + a throwaway `GIT_INDEX_FILE` were forced by the repo's "commit only when asked" rule and paid off (a snapshot is an ordinary commit, so `git diff refs/golem/ledger/<id>` needs no Golem command); destructive half in ADR-0002's never-auto set, safe half deliberately ungated so the habit stays cheap; NO MCP tool (a definition bills every request — the guidance is a skill); the live smoke test caught what 11 green tests missed (a restore deleted Golem's own `.golem/` state in a repo with no `.gitignore`), and restored files carry **git's** line endings, not the disk's
- debriefs/2026-07-30-decision-53-managed-tools.md — spec Decision 53 (Workstream P of the R8 memo): the dependency-tier ladder written down + `src/ext/` registry + `golem ext`; the real invariant is "ship no third-party bytes", not "no binaries"; two audit fixes (`unpdf` was documented optional but mandatory; no `LICENSE` file); a pin is not a passthrough
- debriefs/2026-07-30-brevity-dial.md — spec Decision 52: the slider becomes a preset over two pinnable dials, `compression.level` (input) and the new `brevity.level` (output); Caveman is a prompt that shortens *replies*, not a compression library, which inverts Decision 23's economics because output tokens are never cached; ships OFF behind `golem stats --brevity`; five design errors caught by the repo's own guards (the redaction safety clamp being the important one); Workstream B (`tools`-block shrinking, ~900 tokens of measured headroom) scoped but blocked on a tool-selection-accuracy harness
- **ADRs live at `../decisions/`** (outside this wiki, spec Decision 44): `ADR-0001-file-watcher.md` (accepted: `node:fs.watch` behind a swappable `FileWatcher`), `ADR-0002-autonomy-approval-gates.md` (accepted: R5.4 autonomy threat model — PreToolUse allow/ask gate, fail-closed classifier), `ADR-0003-credential-storage-and-account-routing.md` (PROPOSED: R6.2 multi-account credential threat model + ToS scope)
- debriefs/2026-07-11-T6.md — implemented ADR-0001: `golem index --watch` / `ingest` tool `watch:true` now actually watch and incrementally reindex
- syntheses/r1.1-net-of-cache-ab.md — R1.1 live billed-`usage` A/B: level 1 vs 3 are pipeline-identical on Anthropic post-Decision-31, so there's currently nothing to A/B there
- debriefs/2026-07-11-R1.1.md — shipped `UsageSniffer`/`aggregateUsageByLevel` usage-telemetry infra + the gzip response-decoding fix it required
- syntheses/r1.2-positioning-universal-preprocessor.md — R1.2 positioning call (Decision 32): Golem commits to Decision 22's universal pre-LLM processor; R5.1/WS-F14 unblocked but not yet scheduled
- debriefs/2026-07-11-R1.2.md — recorded Decision 32 + revised README.md/CLAUDE.md copy to lead with redaction/local tools/routing/observability
- debriefs/2026-07-11-R1.3.md — fixed the §50 credit-card redaction false-positive (separator-format guard) + new T-C3 corpus cases
- debriefs/2026-07-11-R1.4.md — closed the §24 provider-key redaction gaps (Google/Stripe/GCP/Azure) with four new dedicated rules
- questions/r1.6-ollama-verification-blocked.md — R1.6 macOS/Linux/no-winget Ollama checklist rows still NOT YET RUN, no non-Windows hardware in this session
- debriefs/2026-07-11-R1.7.md — R1.7's cross-OS e2e smoke + Linux fs.watch matrix was already shipped (T-C2/T6); recorded the Ollama/uv CI-stub decision that was only ever implicit
- debriefs/2026-07-11-R2.5.md — Headroom `read_lifecycle` disable verified from pinned package source: possible but not the right lever; the cache-risky half is already off by default, real cache-safe mechanism is proxy-only and out of reach; recommends R2.6's actual shape
- syntheses/r2.1-avoidedupstream-spike.md — R2.1 spike: no telemetry exists yet for KB-answer substitution (`search`/`fetch`/`ingest`/`wiki_read` uninstrumented); the one real signal (CCR retrieval rate) is 0 misses in 1051 swaps — encouraging but indirect
- debriefs/2026-07-11-R2.1.md — recorded the R2.1 measurement gap + carried the "ship avoidedUpstream telemetry from day one" recommendation into R2.2
- debriefs/2026-07-11-R2.6.md — R2.6: opt-in `force_semantic_on_caching` bypass + `aggregateUsageBySemanticForced` A/B infra built and tested; the live real-traffic A/B itself deliberately deferred (restarting the dogfooded proxy mid-session was judged too risky to do unilaterally)
- debriefs/2026-07-11-R2.4.md — closed the §38 expand↔Headroom-CCR gap: `backfillHeadroomCcrRefs` verifies Headroom's `hash=` markers against SHA-256/MD5 of the elided content and backfills Golem's own CCR store, so `expand` recovers it with no marker-text changes
- debriefs/2026-07-11-R2.2.md — shipped Decision 24 sub-mode 1: proxy-side webcache context substitution (new pipeline stage 4, gated like the semantic stage) + a durable `avoidedUpstream` telemetry bucket
- debriefs/2026-07-11-R2.3.md — shipped Decision 24 sub-mode 2 (Decision 33): opt-in, off-by-default local-answer proxy-as-responder — new frozen `LocalAnswerService` contract + `ProxyRequest.respondDirectly` seam, decoupled from the slider, PROPOSED pending human review of a real served answer
- debriefs/2026-07-11-R3.2.md — R3 batch opens: real `.html`/`.pdf` text extraction (`src/knowledge/extractors.ts`) ahead of chunking, via the optional `unpdf` package for PDFs; `.pdf` was previously entirely unchunkable
- debriefs/2026-07-11-R3.3.md — opt-in `web-tree-sitter` WASM syntax-aware code chunker (`knowledge.syntax_aware_chunking`, default off); grammar packages are devDependencies only, never shipped to `golem-run` consumers
- debriefs/2026-07-12-R3.5.md — `distillNote`/`golem note distill [ts]`: shapes a captured note into a draft `question`/`artifact` wiki page, reusing the existing `.golem/distill/` draft storage and JSON-forcing distill machinery
- debriefs/2026-07-12-R3.4.md — user-scope `~/.golem/wiki/` federated read-only into `search`/`fetch` via `FederatedWikiReader`; `golem wiki synthesize` drafts a weekly through-line over recent debriefs + notes
- syntheses/r3.7-lancedb-scale-spike.md — `FileVectorDriver` benchmark: search stays fast to 30k chunks, but `#flush()`'s whole-collection `Array.join` hard-crashes between 30k-50k chunks (earlier than ROADMAP's assumed 10⁵); no-go on LanceDB today, recommends a cheap stream-write fix instead
- debriefs/2026-07-12-R3.7.md — recorded the LanceDB scale spike finding + go/no-go
- debriefs/2026-07-12-R3.1.md — Decision 34: chat-judge rerank via the existing "judge" role + `jsonSchema` on the frozen `InferenceService.chat()` (no interface change), opt-in `knowledge.rerank_enabled` decoupled from the slider per Decision 31
- debriefs/2026-07-15-R3.6.md — C4: MEMORY-scope federated search via the optional Headroom `[memory]` sidecar (`HeadroomMemorySidecar`); verified the real `easy.Memory` API (docs' `MemoryCategory` doesn't exist in source); search-only (no write path exists yet), opt-in `knowledge.memory_federation_enabled` decoupled from `headroom_sidecar`
- [[Dogfooding Golem]] — two-proxy stable/dev split, daemon lifecycle, promote flow, Headroom sidecar setup (relocated from docs/DEVELOPMENT.md by Decision 36)
- debriefs/2026-07-16-decision-36-refocus.md — Decision 36: roadmap refocused on the co-developer core (R4), old R4/R5 → R5/R6 ON HOLD; spec renamed golem-spec.md, EOL scrubbed, batch briefs retired
- debriefs/2026-07-16-R4.1.md — R4.1: `docs/plan/BACKLOG.md` ideas inbox + `/golem/plan` skill close the second-brain loop into tasks (plan-gated); the last leg of capture → distill → plan
- debriefs/2026-07-16-R4.2.md — R4.2: coder grounding — extracted shared `assembleHits`, `gatherGrounding` size-capped RAG injection into the local drafter (`ground` opt-out), degrades to ungrounded on any failure
- debriefs/2026-07-16-R4.3.md — R4.3: honest tool telemetry — `kind:"tool"` events for search/fetch/ingest/wiki_read/coder (coder tracks drafted-locally chars), surfaced in `stats` MCP tool + `golem stats`
- debriefs/2026-07-16-R4.4.md — R4.4: coder iteration loop — `refineDraft` (judge→revise, opt-in `refine`, best-effort fallback); `/golem/develop` hardened around grounding + refinement
- debriefs/2026-07-16-R4.5.md — R4.5: `golem wiki promote` closes capture→distill→promote (append-and-refine, Decision 26 consent); wiki-lint debt cleared (18→0), checker ignores code-fenced links, `wiki check` in CI
- debriefs/2026-07-16-R4.6.md — R4.6: `FileVectorDriver.#flush()` streams JSON lines (backpressure-aware) instead of one `Array.join` string — removes the ~30k–50k-chunk `RangeError` crash wall
- debriefs/2026-07-16-R4.7.md — R4.7: drafter catalog re-verified (no change — no small qwen3-coder tags); ungrounded draft-quality baseline 2 accept / 3 revise / 0 reject
- syntheses/r4.7-drafter-quality-baseline.md — R4.7 spike: catalog re-verification + measured coder accept-rate baseline (accept for self-contained code, revise for project-integrated)
- syntheses/r4-co-developer-core-batch.md — R4 batch retrospective: all 7 tasks (planning surface, coder grounding/telemetry/refinement, promote+lint, flush fix, re-verification); through-lines + open follow-ups
- debriefs/2026-07-16-R5.2.md — R5.2 (R5 batch opens): consolidated `SessionStateReport` (one zod payload for statusline/dashboard/VS Code/remote) + `golem watch` full-screen TUI (hand-rolled ANSI, no deps) + `.golem/` storage sizing; dashboard serves it at `/api/state`
- debriefs/2026-07-16-R5.1.md — R5.1: durable `TaskStore` (`src/tasks/`, one zod JSON per task under `.golem/tasks/`) + `golem task add/list/show/resume/cancel`; resume mechanism verified as headless `claude -p --resume` (no PTY, verification-notes §65); capacity gate via `notBefore`
- debriefs/2026-07-16-R5.4.md — R5.4: cruise-control autonomy (`src/autonomy/` levels/classifier/gate + `PreToolUse` hook + `golem autonomy`); threat model ADR-0002 written first; default-deny/fail-closed proven (never auto-approves destructive/outward); surfaced in the R5.2 report
- debriefs/2026-07-16-R5.3.md — R5.3: local conversation multiplexing (`src/tasks/multiplex.ts`) — service queued tasks locally (bounded concurrency, fail-open), explicit escalate-to-Claude folding the local pass as grounding (21a); `golem task run`/`escalate`
- debriefs/2026-07-16-R5.5.md — R5.5 (spike): prompt translation (`src/prompt/`) — local rewrite of a raw note into a clearer prompt, always shown/never sent/off proxy path, few-shot on accepted examples; `golem prompt translate/accept`; scoring loop demand-gated
- syntheses/r5-autonomy-orchestration-batch.md — R5 batch retrospective: all 5 tasks (dashboard sidecar, durable tasks, autonomy gates, local multiplexing, prompt-translation spike); through-lines (verify-first, default-deny, local-first explicit escalation, one state contract) + open follow-ups
- debriefs/2026-07-16-init-mcp-permissions.md — `golem init` now pre-approves Golem's MCP tools (`mcp__golem__*` allow + `wiki_upsert` ask); verified MCP permission-rule syntax against Claude Code docs
- debriefs/2026-07-17-le5-decision-33.md — LE5: three embed-path bugs that made the semantic KB unbuildable (input bounding, batching, reindex dim-reset); Decision 33 semantic re-review + finding-#2 prose restriction; the wiki-first payoff ([[Slider Levels]], [[Compression]])
- debriefs/2026-07-17-pre-r6-loose-ends.md — PRE-R6 loose-ends closeout (LE1–LE5) + the auto-resume feature build; coder `refine` judge-model-not-pulled root cause fixed
- debriefs/2026-07-22-golem-snooze.md — spec Decision 38: Golem snooze parks a live session inside a blocking heartbeat tool call until the usage limit resets (#10–#16); limit-prediction observability + document-and-hold PreToolUse trigger, on by default
- debriefs/2026-07-22-coder-first-enforcement.md — spec Decision 39: the `local-coder` guidance becomes an enforced PreToolUse gate (deny the first non-trivial hand-written code write of a session, one-shot); "enforced if guided"
- debriefs/2026-07-22-autonomy-gate-toggle.md — spec Decision 40: decouple the autonomy gate from the shared PreToolUse hook — independently disableable (`golem autonomy disable`), on by default; fixes snooze activation silently turning on outward-command prompts
- debriefs/2026-07-22-decision-41-distribution.md — spec Decision 41 (R7): golem.run install one-liner (nginx UA-sniffing → install.sh/.ps1), npm-first tiered installer + Bun standalone binary, version single-source-of-truth, and `golem update` self-update surfaced in status/statusline/VS Code
- debriefs/2026-07-23-statusline-golem-dir-gating.md — status surfaces run in every project, so they must not footprint non-Golem repos: best-effort writers never bootstrap `.golem/` — the local-model cache (PR #20) and the update-check cache (PR #27, full writer audit) — the VS Code bar/CLI-poll stay quiet outside Golem projects, and the "off" state (proxy stopped or level 0) reads `Passthrough → [local + ]<upstream>` on both surfaces (PR #25)
- debriefs/2026-07-23-webfetch-raw-cache.md — spec Decision 42 (Option A, PreToolUse replace): the pre-hook fetches the RAW page itself on a miss (`fetchRawPage`), caches/ingests it and serves it via `deny` so WebFetch never runs on the happy path (fail-open on fetch failure); not Claude Code's prompt-specific answer; config `knowledge.webcache_fetch_raw` (default on); the local-answer length-gate stays (fail-open path still transits the proxy)
- debriefs/2026-07-24-R6.1b4-kimi-reasoning-vision.md — Kimi K3 works through the existing `openai` provider (no new code); the OpenAI translator gained `reasoning_content`↔Anthropic `thinking`, `reasoning_effort` passthrough, and image passthrough
- debriefs/2026-07-25-architecture-diagrams.md — committed architecture diagrams for the pipeline/proxy/knowledge surfaces
- debriefs/2026-07-25-golem-skills-expansion.md — expanded the seeded `/golem/*` skill set
- debriefs/2026-07-26-golem-managed-credentials.md — spec Decision 46 (amends ADR-0003 invariant 2): an OS-store credential chain (macOS `security` / Linux `secret-tool` / Windows DPAPI, no native deps) with `golem account login/logout`, a fail-closed preflight in `account use`, and CLI-owned resolution injected into the daemon at spawn — ends the "key missing in every new terminal" failure
- debriefs/2026-07-29-credentials-local-model-display-fixes.md — spec Decision 47: removes the env-var credential backend entirely (`golem account login` is the only way to set a key; stdin for CI; the var name survives only as the internal CLI→daemon handoff) and makes `account remove` log out first; adds the `golem local status/enable/disable/url` group for the local/LAN model; fixes two stale displays — the VS Code status bar advertising a disabled local coder, and every surface showing the previous account's model after an upstream switch (`servedModelFor` + clear-on-switch)
- debriefs/2026-07-29-verbatim-model-ids.md — spec Decision 49 (USER): model ids print verbatim on every surface (statusline, `golem status`, VS Code bar/hover/panel) — the R6.2 "friendly" prettifiers (`Opus 4.8`, `Qwen 2.5`) only ever worked for Claude ids, so one line mixed two naming schemes once the upstream showed a raw id; all three helpers plus their VS Code mirrors deleted rather than deprecated
- debriefs/2026-07-29-openrouter-case-b.md — spec Decision 48: `openrouter` moves from case (a) to case (b) (its Anthropic endpoint serves only Claude models, so byte-faithful made the entire free tier unreachable and silently ignored the account's `model`); `vendor/` prefixes preserved for multi-vendor gateways; route/base-URL mismatches warned at `account add`; the credential probe now reports the request URL it does NOT test; the proxy banner names the resolved account instead of the top-level config
