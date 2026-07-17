---
title: LE2 — grounded-refined coder quality
type: synthesis
tags: [pre-r6, inference, coder, drafter, grounding, refine, measurement]
sources: [docs/plan/PRE_R6_BATCH.md, docs/wiki/syntheses/r4.7-drafter-quality-baseline.md, src/mcp/server.ts]
created: 2026-07-17
updated: 2026-07-17
---

# LE2 — grounded-refined coder quality

Fair re-measurement of local `coder` draft quality **with grounding + refine on,
over a real `semantic:bge-m3` index** — the follow-up
[[R4.7 — drafter quality & catalog re-verification]] deferred until the MCP
server ran R4.2 grounding / R4.4 refinement against a semantic (not lexical)
index. Ran the **same 5 representative repo tasks** as R4.7 for a like-for-like
comparison.

## Result

| Task | R4.7 ungrounded | LE2 grounded + refine |
|---|---|---|
| `clampSliderLevel` fn | accept | revise* |
| `union` vitest suite | accept | accept |
| `/golem/plan` skill | revise | revise |
| `gatherGrounding` | revise | **revise (much improved)** |
| `coder-refine.ts` | revise | **revise (much improved)** |

Verdict count: **1 accept / 4 revise / 0 reject** vs R4.7's 2 / 3 / 0.

## Findings

1. **The verdict count is the wrong metric.** It barely moved (and dipped by one
   on model variance — the `*` `clampSliderLevel` flip was a `module.exports`/CJS
   slip, not a grounding regression; grounding actually got the domain value —
   `MAX_SLIDER_LEVEL = 3`, not the prompt's "0–4" — *right*). What actually
   improved is the **quality of the "revise" drafts** for project-integrated
   code: for `gatherGrounding` and `coder-refine`, grounding surfaced the real
   source (`src/mcp/server.ts:670`, `src/mcp/coder-refine.ts`) and the drafts
   reproduced the correct architecture, leaving only mechanical import/wiring
   fixes — versus R4.7's "invented plausible-but-wrong integration." That is far
   cheaper for the paid model to finish, even at the same verdict label.

2. **`refine` fired 0 rounds on all 5.** The judge never flagged a high/medium
   issue worth revising — even the `module.exports`/CJS error a judge should
   catch. So refinement added nothing here. Real follow-up (logged in
   `docs/plan/BACKLOG.md`): the judge threshold/prompt is too lenient, or the
   verdict schema isn't surfacing actionable issues.

3. **Rerank spot-check:** semantic search returns sensible hits
   (`policy.ts:45` `MAX_SLIDER_LEVEL` top at 0.66). But the chat-judge **rerank
   layer is opt-in (`rerank_enabled=false`) and not live** in the running
   server, so only the semantic *substrate* is validated here, not rerank itself.

## Takeaway
The co-developer thesis holds: grounding makes local drafts *cheaper to finish*,
which is the point (leave the paid model the judgment calls). The measured lever
to improve next is **refine**, not grounding. See [[PRE-R6 loose-ends closeout]].
