---
title: WIKI
type: schema
tags: [meta]
sources: []
created: 2026-07-10
updated: 2026-07-10
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
- [[Distillation Pipeline]] — capture -> distill -> promote data flow (capture stage built, T4)
- sources/llm-wiki-second-brain-obsidian.md — distilled source note for the
  originating article
- `questions/` — open questions carried over from the Decision 28 proposal
- debriefs/2026-07-10-T7.md — entropy sweep path false-positive fix
- debriefs/2026-07-10-T1.md — wired durable `ccrRefsRetrieved` telemetry
- debriefs/2026-07-10-T2.md — shipped the missing `wiki-query`/`wiki-ingest` skills
- debriefs/2026-07-10-T4.md — shipped `golem note` capture (spec Decision 20f)
