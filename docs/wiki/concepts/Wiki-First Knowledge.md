---
title: Wiki-First Knowledge
type: concept
tags: [knowledge-base, architecture]
sources: [docs/plan/proposals/wiki-knowledge-pivot.md]
created: 2026-07-10
updated: 2026-07-11
---

# Wiki-First Knowledge

The storage model adopted by Golem in spec Decision 28: durable knowledge lives as
zoned, committable markdown pages; the vector store is a derived, rebuildable
retrieval index over those pages (plus raw capture and code). Retrieval is
graph-first (title/alias/wikilink lookup), vector-second (semantic discovery).

Inverts the chunks-primary RAG model, where the embedded index *is* the knowledge —
opaque, per-machine, unshareable, and lost with the index. Pages, by contrast, double
as human documentation, travel with the repo, and make agent-written knowledge
auditable and correctable in review.

Key mechanics: plan-gated agent writes, required frontmatter with `sources`,
distilled source notes instead of raw mirrors (see
[[llm-wiki-second-brain-obsidian]]), and a strict link-don't-restate rule against
duplicating what code or docs already record.

Design and phasing: docs/plan/proposals/wiki-knowledge-pivot.md (workstream WS-W).

## Retrieval order (implemented, T5)

The `search` MCP tool runs both tiers on every call, cheapest first:

1. **Graph-first** (`graphFirstWikiHits`, `src/mcp/server.ts`): exact/case-insensitive
   match of the query against a wiki page title, then a 1-hop expansion along that
   page's outgoing wikilinks (`extractWikilinks`). No embedding call — one
   `listPages()` scan per invocation. Matches score above any vector hit, so a query
   that names a page (or is one hop from it) always surfaces that page first.
2. **Vector search** (`knowledge.search`): runs unconditionally, so free-text queries
   that don't name a page still work.

Results are merged (graph hits first), de-duplicated by `sourcePath` — a vector hit
covering the same file as a graph hit is dropped, the graph hit wins — then reranked
by the existing `boostWikiHits` wiki-dir boost (W1c). Graph-first hits carry a
synthetic `wiki:<relPath>` chunk id; `fetch` resolves those straight from the
`WikiStore` rather than the vector store. Degrades to vector-only search when no
`WikiStore`/`wikiDir` is configured. See [[Distillation Pipeline]] for how pages get
into the wiki in the first place.
