---
title: WIKI
type: schema
tags: [meta]
sources: []
created: 2026-07-10
updated: 2026-07-16
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
| 2 — wiki | `concepts/ entities/ sources/ syntheses/ questions/ artifacts/` | agent, **plan-gated** | propose a plan, get approval, then write; append-and-refine, never wholesale rewrite |
| 3 — dev | `decisions/ debriefs/` | human drives, agent co-pilots | accepted ADRs immutable except status; superseded, never deleted |

Hard rules for every write, agent or human:

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
  `ADR-NNNN-slug.md` for decisions; `YYYY-MM-DD-slug.md` for debriefs.
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

- [[Wiki-First Knowledge]] — the pattern this wiki implements
- [[Guidance Rules]] — how Golem's working practices are stored as Claude Code `.claude/rules/golem-*.md` (seeded by init, toggled by `golem guidance`)
- [[Redaction Stage]] — rule table, entropy heuristic, known false-positive classes
- [[Slider Levels]] — the 0–3 compression dial; level 0 = passthrough (redaction OFF, Decision 30); slider never engages the local model (Decision 31)
- [[Compression]] — situational savings (Decision 23): lossless/CCR always pays, lossy semantic only on non-caching upstreams (~0% on Anthropic cached)
- [[Distillation Pipeline]] — capture -> distill -> promote data flow (capture + distill built, T4/T3)
- syntheses/wiki-knowledge-loop-batch.md — retrospective tying the T1–T7 batch + init-guidance work into one knowledge loop; records patterns + open follow-ups
- sources/llm-wiki-second-brain-obsidian.md — distilled source note for the
  originating article
- sources/local-coder-models-2026.md — distilled landscape of small local coder models (Qwen3-Coder vs Qwen2.5-Coder; Ollama tag availability), captured during R4.7
- `questions/` — open questions carried over from the Decision 28 proposal
- debriefs/2026-07-10-T7.md — entropy sweep path false-positive fix
- debriefs/2026-07-10-T1.md — wired durable `ccrRefsRetrieved` telemetry
- debriefs/2026-07-10-T2.md — shipped the missing `wiki-query`/`wiki-ingest` skills
- debriefs/2026-07-10-T4.md — shipped `golem note` capture (spec Decision 20f)
- debriefs/2026-07-11-T5.md — graph-first lookup ahead of vector search in `search`
- debriefs/2026-07-11-T3.md — distillation engine + lazy webcache distill (`golem wiki distill`)
- debriefs/2026-07-11-golem-init-guidance.md — baked wiki-promotion + local-model-first practices into the `golem init` guidance template
- decisions/ADR-0001-file-watcher.md — accepted: `node:fs.watch` (native recursive on Windows/macOS, manual per-directory on Linux) behind a swappable `FileWatcher` interface, `chokidar` deferred unless proven necessary
- decisions/ADR-0002-autonomy-approval-gates.md — accepted: R5.4 threat model — autonomy levels (manual/assisted/outcome, no full-auto), PreToolUse gate emitting allow/ask, conservative fail-closed classifier, default-deny proofs; enforcement never auto-allows destructive/outward
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
