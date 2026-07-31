---
title: Cache Observability
type: concept
tags: [cache, telemetry, observability, r8, prompt-caching]
sources: [src/proxy/cache-prefix.ts, src/telemetry/cache-report.ts, src/pipeline/pipeline.ts, docs/plan/verification-notes.md]
created: 2026-07-30
updated: 2026-07-31
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
- **`bust`** — the cached prefix was not reused, naming the cause:
  - `tools` / `system` / `messages` — content changed. For `messages` the first
    changed index is reported. A `tools` bust is the expensive one: it renders
    first, so it re-prefills everything.
  - `lookback` — **nothing changed.** The prefix is still byte-identical and still
    live, but it sits more than 20 blocks behind the breakpoint, so the read cannot
    find it. Fixed with an extra `cache_control` breakpoint, not with fewer edits.

A shrinking history (a compaction or a rewind) is a bust too — the prefix no
longer matches.

## A bust is only as expensive as the history behind it

A change at message 2 of 180 re-prefills essentially everything. A change at
message 179 of 180 costs the tail. **Reporting both under one counter is how a
98%-bust report survived next to a 98.4% billed hit rate for a day** (§99). So the
report names the deepest one:

```
deepest history bust: message 40 of 43 — 3 message(s) (7.0% of history) re-prefilled
```

## §99 — the day the verdict was 98% wrong, and what it actually was (§104)

Within minutes of going live the proxy produced **142 `bust` / 3 `first` /
0 `append`** — ~98% busts — against a **billed 98.4% hit rate** over the same
period. Both cannot be true, and the billed number is the measured one.

§99 blamed the conversation key (many short conversations colliding onto one hash of
`messages[0]`). **That was wrong**, and disproving it cost one extra recorded number.
Once the bust *index* was recorded, the pattern was unmissable: the bust landed on
`prevCount - 1` — the previous request's final message — on **every single turn**.

The real cause: **Claude Code moves its `cache_control` breakpoint to the newest
block each turn**, so the previously-final block loses a key it used to carry and its
hash changes. But `cache_control` is a *breakpoint marker, not cached content* —
Anthropic's docs say so outright for this exact case: "blocks that were previously
marked with a `cache_control` block are later not marked with this, but they will
still be considered a cache hit". Golem was hashing a marker as if it were content.

Fixed by excluding `cache_control` from every fingerprint (§104). Live result on the
same workload: **0% append → 73% append**, billed hit rate 99.0%, and the surviving
busts are real — they bill **3.3× the cache write** of an append turn (2,951 vs 892
tokens mean). Before the fix the verdict predicted nothing, because everything was a
bust.

**This is what the two-signal design bought.** A blended "cache health score" would
have averaged a correct measurement with a 98%-wrong prediction and looked
plausible; keeping them apart made the contradiction visible on day one. The
disagreement warning in `golem stats --cache` is kept as a standing consistency
check on the predictor, not retired with the bug it caught.

## Stated limits

- **Conversation identity is a heuristic.** The Messages API carries no session id,
  so requests are grouped by a fingerprint of the first message. Two threads
  opening with identical first messages are indistinguishable; the cost is one
  misattributed verdict, never a wrong bill. §99 suspected this was the dominant
  failure; §104 measured it and found the key working fine on real traffic.
- **A `lookback` bust is predicted only for a single-breakpoint request.** A second
  `cache_control` opens a second lookback window that would find the earlier write,
  so predicting a miss there would be a false positive. Claude Code uses several
  breakpoints, so this verdict is expected to be rare in practice.
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
