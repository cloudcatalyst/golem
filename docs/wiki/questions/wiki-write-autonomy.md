---
title: wiki-write-autonomy
type: question
tags: [knowledge-base, autonomy]
sources: [docs/plan/proposals/wiki-knowledge-pivot.md, docs/golem-spec.md]
created: 2026-07-10
updated: 2026-07-25
---

> **Update (2026-07-25, spec Decision 44):** answer #1 below is reversed. The
> agent may now author or refine wiki pages **freely, without a plan gate** —
> every write is committed to git, so it's reviewable and revertible in history.
> The other hard rules still bind (redaction-before-storage; contradictions
> surfaced to the human, never auto-resolved). Decisions (ADRs) moved out of the
> wiki to `docs/decisions/` and keep the stricter human-driven rule. The
> original resolution is preserved unedited below as the point-in-time record.

# Resolved — when may the agent write wiki pages without a plan gate?

**Status: resolved by spec Decision 29 (2026-07-10)**, ahead of implementing
WS-W W2. Answers (see the decision for full reasoning):

1. Auto-append autonomy: never, through P1/P2 — confirmed; doc-level gating
   only (no in-protocol confirmation step, same as every other Golem tool).
2. MCP tool shape: two tools, `wiki_read` / `wiki_upsert` (not merged).
3. Webcache backfill: lazy, on next access — not part of W2 (moved to W3).
4. Auto-memory boundary: confirmed as already stated below.

Original question preserved unedited for the record.

## Open question — when may the agent write wiki pages without a plan gate?

Carried over from the [[Wiki-First Knowledge]] proposal (open questions 2–4):

1. **Auto-append autonomy:** never in P1/P2 is the working answer; revisit with
   Decision 20d autonomy levels (per-task, explicit, gated for irreversible acts).
2. **MCP tool shape:** `wiki_read` + `wiki_upsert` as two tools vs one `wiki` tool
   with an `action` param — tool-count pressure on the Decision 27 seven-verb surface.
3. **Webcache backfill:** distill the entire existing webcache eagerly, or lazily on
   next access?
4. **Auto-memory boundary:** Claude Code memory stays personal/behavioral; project
   knowledge belongs here. A memory that turns out to be project knowledge should
   graduate to a wiki page.
