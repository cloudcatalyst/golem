---
title: WIKI
type: schema
tags: [meta]
sources: []
created: 2026-07-10
updated: 2026-07-11
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
   `docs/edge-offload-spec.md` stays authoritative for decisions.
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
- [[Redaction Stage]] — rule table, entropy heuristic, known false-positive classes
- [[Distillation Pipeline]] — capture -> distill -> promote data flow (capture + distill built, T4/T3)
- syntheses/wiki-knowledge-loop-batch.md — retrospective tying the T1–T7 batch + init-guidance work into one knowledge loop; records patterns + open follow-ups
- sources/llm-wiki-second-brain-obsidian.md — distilled source note for the
  originating article
- `questions/` — open questions carried over from the Decision 28 proposal
- debriefs/2026-07-10-T7.md — entropy sweep path false-positive fix
- debriefs/2026-07-10-T1.md — wired durable `ccrRefsRetrieved` telemetry
- debriefs/2026-07-10-T2.md — shipped the missing `wiki-query`/`wiki-ingest` skills
- debriefs/2026-07-10-T4.md — shipped `golem note` capture (spec Decision 20f)
- debriefs/2026-07-11-T5.md — graph-first lookup ahead of vector search in `search`
- debriefs/2026-07-11-T3.md — distillation engine + lazy webcache distill (`golem wiki distill`)
- debriefs/2026-07-11-golem-init-guidance.md — baked wiki-promotion + local-model-first practices into the `golem init` guidance template
- decisions/ADR-0001-file-watcher.md — accepted: `node:fs.watch` (native recursive on Windows/macOS, manual per-directory on Linux) behind a swappable `FileWatcher` interface, `chokidar` deferred unless proven necessary
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
