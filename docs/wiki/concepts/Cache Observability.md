---
title: Cache Observability
type: concept
tags: [cache, telemetry, observability, r8, prompt-caching]
sources: [src/proxy/cache-prefix.ts, src/telemetry/cache-report.ts, src/pipeline/pipeline.ts, docs/plan/verification-notes.md]
created: 2026-07-30
updated: 2026-07-30
---

# Cache observability — hit rate, and what broke the prefix

Anthropic's prompt cache keys on a **byte-identical prefix**, rendered
`tools` → `system` → `messages` (verification-notes §14). One changed byte
invalidates everything after it. The request still succeeds, the answer is still
right, and the bill quietly moves from ~0.1× cache-read rates to full input rates.
Nothing in the stack tells you.

Golem sits on the request path and sees the exact bytes it forwards, so it can.
`golem stats --cache` (R8.1).

## Two signals, never merged

| | Source | Says | Authority |
|---|---|---|---|
| **Billed** | `cache_read_input_tokens` / `cache_creation_input_tokens` / `input_tokens` off each response (R1.1 sniffer, `kind: "usage"` events) | *whether* the cache hit, and what it cost | ground truth |
| **Observed** | Per-request prefix verdict from `CachePrefixObserver`, on pipeline events | *why* — which component and which turn broke it | a prediction |

They are printed side by side and never blended into one score. The billed number
is true but silent about cause; the verdict explains but can be wrong at the
margins. A single "cache health" figure would hide precisely the distinction a
reader needs.

## Verdicts

- **`first`** — no previous request for this conversation.
- **`append`** — prefix components identical and `messages` only grew. The normal
  agentic turn; the cache should hit.
- **`bust`** — an earlier byte changed, naming the component (`tools`, `system`,
  `messages`) and, for `messages`, the first changed index. A `tools` bust is the
  expensive one: it renders first, so it re-prefills everything.

A shrinking history (a compaction or a rewind) is a bust too — the prefix no
longer matches.

## Stated limits

- **Conversation identity is a heuristic.** The Messages API carries no session id,
  so requests are grouped by a fingerprint of the first message. Two threads
  opening with identical first messages are indistinguishable; the cost is one
  misattributed verdict, never a wrong bill.
- **Only pipeline-transiting requests are classified.** A byte-faithful request
  emits no event (the established convention shared with the semantic and
  context-substitution stages), and level 0 is a full bypass. Unobserved requests
  are counted and reported *as unobserved* — never as hits.
- **Fingerprints are hashes**, not bytes: nothing here holds prompt content.

## What it measured first — and why that changed the plan

Run against this repo's own telemetry on the day it shipped (§93): **98.4% hit
rate** over 7,874 responses, with uncached input at **0.06%** of billed input.

So bust-prevention is nearly irrelevant *here* — there is almost nothing to
recover. Weighted by rate, **~83% of input cost is re-reading an already-cached
context**, turn after turn. That demoted the bust detector to a guard rail and
promoted the levers that shrink what sits in context: [[Compression]]'s dedup
work, the planned repo map, and the context ledger.

Do not generalise 98.4%. It measures this setup — one project, Claude Code as the
client, slider 3 — and Claude Code is unusually disciplined about cache stability.
The point of shipping the rollup is that anyone can now measure their own instead
of assuming.

## Related

- [[Compression]] — why input-side compression pays ~0% on cached traffic (Decision 23)
- [[Slider Levels]] — level 0 is a full bypass, so it is never observed
- [[Tool Search]] — why the `tools` block is the most expensive thing to churn
- [[Managed Tools]] — the same honesty rule applied to capability reporting
