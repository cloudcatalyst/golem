---
title: Wiki-First Knowledge
type: concept
tags: [knowledge-base, architecture]
sources: [docs/plan/proposals/wiki-knowledge-pivot.md, src/wiki/federated-wiki-reader.ts]
created: 2026-07-10
updated: 2026-07-12
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

## Zone 1 -> zone 2 data flow (implemented, T3/T4)

Raw capture never enters the wiki directly. The path in:

1. **Capture**, zone 1, no inference: `golem note` (notes.jsonl) and WebFetch's
   PostToolUse hook (webcache) both redact-then-store raw text locally,
   gitignored, uncommitted.
2. **Distill**, zone 1, local model: `golem wiki distill <url>` (or the lazy
   pointer the WebFetch pre-hook leaves on a cached URL) turns a webcache
   entry into a wiki-shaped draft under `.golem/distill/<slug>.md` — still
   zone 1, still not committed, but already carrying real frontmatter and a
   summary in the model's own words instead of a raw mirror.
3. **Promote**, zone 2, human-gated: an agent reviews the draft, proposes it
   to the user, and only on approval calls `wiki_upsert` to commit it under
   `sources/` (or another zone). This is the same plan-gate every zone-2
   write goes through (Decision 29) — distillation produces a better-shaped
   proposal, it does not skip the gate.

Full detail on each stage: [[Distillation Pipeline]].

## User-scope wiki tier (built, R3.4)

Spec Decision 20e phases tiered user/workspace/org knowledge starting at
**local (user) scope in P1**, alongside the project's own wiki; workspace/org
sync is a P4+ hosted tier, not yet built. The user-scope root lives at
`~/.golem/wiki/` (one directory per machine user, not project-relative —
`defaultUserWikiDir()`, `src/cli/wiki.ts`), scaffolded the same way as a
project wiki via `golem wiki init --user`.

`FederatedWikiReader` (`src/wiki/federated-wiki-reader.ts`) merges the
project `WikiReader` and the user-scope one into a single read-only surface:
user-wiki `relPath`s are prefixed `user:` to avoid colliding with project
paths, a title collision favors the project page, and `backlinks()` is
computed over the merged page set so a wikilink can cross between the two
wikis. Writes are never federated — `wiki_upsert` always targets the single
project `WikiStore`; only `search`/`fetch` see the merged view, via a new
`wikiSearch` field on `GolemMcpServerDeps` that defaults to the project
`wiki` when federation is off. Because the graph-first search machinery
(`graphFirstWikiHits`, `pageToHit`, `isUnderWikiDir`) only depends on the
generic `WikiReader` interface and treats `relPath` as opaque, federating in
a second wiki required zero changes to that machinery — only the two wiring
points (the deps field, and its one call site in `golem mcp serve`) needed
touching. Opt-out via `knowledge.user_wiki_enabled` (default `true`) for
anyone who doesn't want personal notes bleeding into a project's search
results.
