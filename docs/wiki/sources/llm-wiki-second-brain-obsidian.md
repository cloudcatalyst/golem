---
title: llm-wiki-second-brain-obsidian
type: source
tags: [knowledge-base, obsidian, second-brain]
sources: ["https://medium.com/@roanmonteiro/building-a-complete-personal-harness-llm-wiki-developers-second-brain-in-obsidian-d7b61c7398ff"]
created: 2026-07-10
updated: 2026-07-10
---

# Source note — "Building a Complete Personal Harness: LLM Wiki + Developer's Second Brain in Obsidian" (Roan Brasil Monteiro, Medium)

The article that inspired [[Wiki-First Knowledge]] (Decision 28). Distilled points
Golem adopted, adapted, or rejected:

**Adopted**
- Zoned vault with one governing rule: the agent doesn't touch what the human
  curated; the human rarely touches what the agent maintains. Zone 0 is a schema
  file the agent reads every session (our `WIKI.md`).
- Agent-maintained concept/entity/synthesis pages, wikilinks mandatory, required
  frontmatter (`title/type/tags/sources/created/updated`).
- **Plan-before-write ingestion:** extract concepts → check existing pages → present
  a plan → only write after approval. Append-and-refine, never rewrite.
- ADR rules: accepted = immutable except status; superseded never deleted;
  contradictions reported to the human, not auto-resolved.
- Query contract: cite pages, flag inference vs. sourced fact, admit gaps.
- Git as the safety net; the agent never runs git itself.

**Adapted**
- The author's `raw/` zone is human-curated clippings; Golem's raw zone is automated
  capture (webcache + CCR), local-only and gitignored — distilled source notes like
  this one are what get committed (copyright/PII).
- The author budgets $20–50/month of Claude tokens for ingestion; Golem routes
  distillation through local models (`delegate`, WS-D) at ~zero marginal cost.
- Retrieval: the article uses grep-based lookup only (fine to a few hundred notes);
  Golem keeps semantic search as the second stage over the same pages.

**Rejected**
- Obsidian dependency (all three integration paths). Golem keeps the format
  Obsidian-compatible but tool-independent — plain files, standard tooling. The
  article itself flags a data-loss bug in the Local REST API plugin's POST path.

Author's core claim, worth keeping: connection density compounds — the 100th
ingested article links to ~30 earlier pages, which is what makes a wiki an asset
rather than "a polished hallucination". The gate + citations are what earn that.
