---
title: 2026-07-25 — Architecture diagrams
type: debrief
tags: [architecture, diagrams, wiki, readme, mermaid]
sources: [docs/wiki/concepts/Architecture.md, docs/wiki/concepts/Web Cache.md, docs/wiki/concepts/Knowledge Base.md, README.md]
created: 2026-07-25
updated: 2026-07-25
---

# 2026-07-25 — Architecture diagrams

## What shipped
The project's architecture was described only in prose (spec §2's ASCII block
aside), so a technical reader couldn't quickly see how a request flows or how the
pieces fit. Added Mermaid **component-interaction diagrams** across the wiki and
README:

- New **[[Architecture]]** hub page — the visual deep-dive entry point: component
  topology, the proxy request lifecycle, local/LAN/upstream routing (tier
  step-down + Haiku fallback; case-a byte-faithful vs case-b translating
  providers), observability ("one state source, thin renderers"), and the
  PreToolUse guardrail stack.
- New **[[Web Cache]]** — WebFetch fetch-cache-serve sequence (Decision 42 raw
  mode) + a freshness/revalidation state machine.
- New **[[Knowledge Base]]** — RAG ingest path and the graph-first-then-vector
  search path; scopes/federation; notes that the shipped driver is
  `FileVectorDriver`, not spec §3.1's Qdrant.
- Embedded focused diagrams into [[Slider Levels]] (per-level stage gating),
  [[Redaction Stage]] (redaction-first ordering), [[Compression]] (CCR ref
  lifecycle), and [[Distillation Pipeline]] (capture→distill→promote + zones).
- README got a lean two-diagram "How it works" section linking to the hub; the
  `WIKI.md` Index gained the three new pages.

## Decisions / rationale
- **Mermaid over binary/render-step tools** (Excalidraw, PlantUML/Graphviz/D2):
  it renders natively on GitHub/VS Code/Obsidian with zero build step and diffs
  in git like the rest of the wiki — matching the Decision 44 ethos. Split into
  several focused diagrams (Mermaid degrades when overloaded), each captioned
  with the `src/…` file it reflects.
- **Diagrams follow the code, not the spec** where they differ (e.g.
  FileVectorDriver vs Qdrant), with a one-line note.

## Verification
`golem wiki check` → 84 pages, no issues (all new wikilinks resolve). Mermaid
fences balanced; parser-sensitive spots hardened (no parens/slashes in sequence
aliases, no stray angle brackets). Docs-only — no `src/` change.

## Follow-ups (logged in `docs/plan/BACKLOG.md`)
- Diagram of the dogfooding two-proxy setup → [[Dogfooding Golem]].
- Diagram of task multiplexing (`src/tasks/multiplex.ts`) + prompt translation
  (`src/prompt/`).

See also [[Wiki-First Knowledge]].
