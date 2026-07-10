---
title: Wiki-First Knowledge
type: concept
tags: [knowledge-base, architecture]
sources: [docs/plan/proposals/wiki-knowledge-pivot.md]
created: 2026-07-10
updated: 2026-07-10
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
