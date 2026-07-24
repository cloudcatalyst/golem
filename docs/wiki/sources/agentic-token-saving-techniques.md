---
title: Agentic Token-Saving Techniques
type: source
tags: [tokens, cost, caching, routing, compaction, tool-search]
sources: [https://medium.com/data-science-collective/agentic-ai-how-to-save-on-tokens-9a1571ac6c85]
created: 2026-07-24
updated: 2026-07-24
---

# Agentic Token-Saving Techniques

Distilled from Ida Silfverskiöld, "Agentic AI: How to Save on Tokens" (2026-05).
Raw page cached in the webcache (zone 1). Four families of technique, mapped to
where Golem already stands.

## 1. Reuse tokens (caching)
- **Prompt / prefix caching** — exact-prefix match; one changed byte (space,
  reordered tool def, timestamp) busts it. OpenAI auto-caches ≥1024-token prompts
  (routes on first 256 tokens); Anthropic needs `cache_control`, ~5–10 min TTL
  (extendable to 1h at 2× store cost), up to 90% off cached input. → Golem
  respects this via [[Compression]]'s cache-alignment; honest ~0% savings on
  Anthropic cached traffic (Decision 23).
- **Semantic caching** — embed the request, serve a prior answer on high cosine
  similarity. Big wins for repetitive Q&A, risky for unique/coding traffic;
  needs TTL, scoping, thresholds. → spec §3.4, slider-gated; live A/B parked
  until non-caching upstreams (R6.1).
- **Cache deterministic outputs** (SQL, tool, retrieval results). → webcache +
  exact response cache.

## 2. Don't preload dormant tokens (lazy loading)
The biggest "always-added" sink is tool/MCP definitions (article cites Anthropic's
55K–134K tokens of defs). Keep a small stable top layer; fetch details on demand.
**Anthropic Tool Search** (`tool_search_tool_bm25_20251119`, `defer_loading: true`,
matched defs re-injected as `tool_reference` blocks) is the shipped mechanism.
→ Not yet in Golem — see `docs/plan/BACKLOG.md` "lazy tool-definition loading".
Golem's position on the request path makes in-proxy pruning viable, and it saves
even on cached Anthropic traffic where compression can't.

## 3. Cheap models for cheap work (routing / cascading)
- **Predictive routing** — estimate difficulty up front (RouteLLM, OpenRouter
  Auto). LLMRouterBench: learned routers barely beat heuristic/kNN baselines.
- **Cascading** — cheap model first, escalate on low confidence (Google
  Speculative Cascades; CascadeFlow claims 69% savings / 96% quality on
  verifiable tasks). → Golem has local→Claude escalation (R5.3); paid-side tier
  cascade is a natural extension.
- **Subagents** — delegate to isolated (often cheaper) agents; ~11% aggregate
  saving since the orchestrator stays in the loop. → `coder`, task multiplex.

## 4. Keep context clean (compaction)
Agents accumulate exhaust (tool outputs, logs, dead-end retries). Archive raw
output, keep only active state; "make tools less noisy by default." Cited: 6×
compression → 51.8–71.3% token cut *and* +5–9% SWE-bench resolution (Jia et al.).
→ This is exactly Golem's CCR-swap for oversized tool outputs (see the
[[Wiki-First Knowledge]] loop and the ccr-refs rule) — the strongest validation
of the existing design.

## Golem takeaways
The honest gaps worth building are **lazy tool-def loading** and **cache-hit
observability** — both exploit Golem's request-path position and save tokens on
cached Anthropic traffic where [[Compression]] cannot. Routing/cascading and
semantic caching are already on the roadmap.
