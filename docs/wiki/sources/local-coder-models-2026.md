---
title: local-coder-models-2026
type: source
tags: [inference, coder, ollama, models]
sources: [https://localaimaster.com/models/best-local-ai-coding-models, https://ollama.com/library/qwen3-coder]
created: 2026-07-15
updated: 2026-07-15
---

# Source note — local coder models landscape (mid-2026)

Distilled from 2026 ranking pages and the Ollama library during R4.7's catalog
re-verification (Decision 6). In our own words; cite the URLs above.

**Generations.** Qwen3 is the current successor to Qwen2.5. **Qwen3-Coder** is
the 2026 default recommendation for *agentic / multi-file* coding — MoE
architecture (e.g. 30B total / ~3.3B active), 256K context.

**But for single-function / single-file code quality, Qwen2.5-Coder still
narrowly leads** (reported HumanEval ~92.7% at 32B; described as the cleanest,
most idiomatic single-file output of local models tested). This is the regime
Golem's `drafter` role operates in — cheap first draft, then Claude refines.

**Availability constraint (decisive for Golem).** On Ollama, `qwen3-coder`
ships only in **`30b`** and **`480b`** tags — there are **no small variants**
(no 7b/3b/1.5b). So Golem's small tiers (P_CPU/P_MIN/P_MID) have no drop-in
qwen3-coder replacement; qwen2.5-coder (1.5b/3b/7b/14b) remains the fit.

**Other names seen in the rankings** (not adopted): Devstral, DeepSeek-Coder
V2 Lite, Kimi-family, Phi-4 — none clearly beat qwen2.5-coder for the small
single-draft niche.

**Benchmark caveat.** All figures are directional — HumanEval/SWE-bench vary by
prompt template, sampling, and evaluator version.

Informs Golem's decision to keep the catalog unchanged — see
[[R4.7 — drafter quality & catalog re-verification]] and
`src/inference/catalog.ts`.

