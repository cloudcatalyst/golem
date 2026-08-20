---
title: 2026-07-31 — Headroom's net gate, and the level that was lying
type: debrief
tags: [compression, tokens, caching, headroom, status, shipped]
sources: ["docs/plan/verification-notes.md (§103, §34, §35, §93, §31, §32)", "scripts/measure_headroom_cache.py", "scripts/measure_headroom.py", "src/compression/effective-level.ts", "src/cli/status.ts", "src/cli/statusline.ts", "src/mcp/server.ts"]
created: 2026-07-31
updated: 2026-07-31
---

# Headroom's net gate, and the level that was lying

**Verdict: the gate was right, the numbers were bigger than recorded in BOTH
directions, and the status display was wrong.** §34 measured Headroom's gross
saving on 2026-07-05 and closed with an explicit refusal: *"No net savings may be
claimed until this is measured live."* That question sat open for 25 days. It is
now answered — offline, for free — and the answer is decisive enough to close a
line of work.

## How it started

Not from the roadmap. A GPU spike prompted a question about Ollama's keep-alive
(§102), and the follow-up — *"there is currently no Headroom compression being
applied, can we test whether it saves tokens?"* — was correct on the facts:
`compression.headroom_sidecar` was `true` and the slider was at 3, yet
Decision 31's gate meant the sidecar **never starts** against Anthropic. The
question was worth answering because nobody had.

## The two numbers

**Gross savings are larger than §34 recorded**, and §34's single sample could not
have shown why:

| transcript | messages | tokens before | gross saved |
|---|--:|--:|--:|
| 2026-07-30 | 1,404 | 445,116 | **7.08%** |
| 2026-07-15 | 4,631 | 2,010,745 | **21.69%** |
| §34's, 2026-07-05 | 2,008 | 787,169 | 5.48% |

Savings **scale with session length** — 1,433 transforms fired on the long one.
`read_lifecycle` earns more the longer an agent works, because more files get
re-read and superseded.

**Net on a caching upstream is the opposite story.** The insight that made this
cheap: you do not need live billing. Find the first index where the compressed
history stops matching the original — everything after it cannot be a cache hit.

| | 4,631-msg | 1,404-msg |
|---|--:|--:|
| first divergence | message **6** | message **21** |
| prefix still cache-readable | **0.01%** | **1.00%** |
| cost vs not compressing | **8.74×** | **11.25×** |

## Why that is structural, not a tuning problem

`read_lifecycle` saves tokens by dropping the *earliest superseded* copy of a
re-read file. **Its value and its cache damage are the same act** — the stalest
copy is by construction near the start of history. A transform that only touched
the tail would be a different, weaker transform. Against the 98.4% billed hit rate
of §93, 0.1× on everything beats 1.25× on 70% of it by an order of magnitude.

On a **non-caching** upstream the same runs are a clean **9.06% / 30.09%** win.
That is Decision 23's "compression is situational" measured on *both* sides
rather than asserted on one.

## What it closed

- **`force_semantic_on_caching` is now proven unsafe**, not merely unproven. Its
  own doc comment asked for "a real `aggregateUsageBySemanticForced` comparison"
  before trusting it; that comparison would now be spending real tokens to confirm
  a ~9× loss.
- **R2.6 was rewritten, not closed.** It still needs non-caching credentials, but
  its premise line said cached traffic is "~0%" — wrong in an important direction.
  It now carries an explicit "do not spend tokens confirming the caching side" and
  a note to pre-screen the non-caching run offline first.
- **`scripts/measure_headroom_cache.py` is the reusable bar.** Any future
  compressor — Caveman-class, context substitution, a new Headroom release — must
  report **first-divergence index**, not just gross tokens. A compressor that only
  rewrites the *tail* of history could pass this gate where Headroom fails it. That
  is the shape worth looking for.

## The second finding: the display was lying

Confirming the gate meant reading the status output, which said:

```
Slider: level 3 (aggressive) — set by local (…)
```

True about the setting, false about the behaviour. The pipeline was running level
1. **Five surfaces had this bug**, and the fix took two passes worth recording:

1. First pass added a **warning line beneath** the headline. Not enough — a
   footnote under a headline that still reads "aggressive" leaves the headline
   wrong, and `golem statusline` (the per-prompt surface, so the most-read version
   of the misreport) showed `Aggressive` with no indication at all.
2. Second pass put the truth **in the label**:

```
status      Slider: level 3 (aggressive) → effectively 1 (lossless) — set by …
            Dials: … · compression 3→1 (auto — follows slider 3)
              ⚠ level 3 (aggressive) is inert here: <reason>
statusline  ⬢ Golem · Lossless → … · ⚠ 3 inert          (was: · Aggressive → …)
TUI         Level  1 lossless (3 inert)
slider <n>  warns at set time
level MCP   effective_level in text + structuredContent
```

`src/compression/effective-level.ts` owns the prediction and took over
`isCachingUpstream` from `pipeline.ts`, so the CLI and the pipeline cannot
disagree. **`pipeline.ts` remains the enforcement point**; a truth-table test pins
the prediction to it, including that both unknown-URL cases answer "caching" —
the fail-safe direction, since guessing wrong the other way costs ~9×.

## Two judgment calls, recorded

- **Warn, do not restrict.** The obvious reading of "restrict the slider on
  upstreams where it is wrong" is to refuse the write. That would be wrong here:
  the same project is used against non-caching accounts where levels 2–3 are
  exactly right, so the level is a valid thing to have set — it is only inert
  *right now*. Refusing would make a correct future configuration unreachable and
  need undoing on every `golem account use`.
- **The `level` MCP tool was included even though it is agent-facing.** Its reply
  enters the model's context, so "aggressive" there teaches the model a false
  belief about its own context budget. It takes the prediction as an injected
  thunk so the MCP server keeps its no-config-dependency property.

## Honest limits

- The cache script's flattening tokenizer counts 1.27M where Headroom's counts
  2.01M. **Absolute cost-units are understated; the A/B ratio is not** — both arms
  use the same counter, and first-divergence is tokenizer-independent.
- It prices one steady-state turn against a warm cache, not a replay with Claude
  Code's real ≤4 cache breakpoints. That would change the multiple, not the sign:
  with divergence at message 6, no breakpoint placement rescues the prefix.
- Measured on this repo's own agent traffic. A different re-read profile gives a
  different gross number; the net argument depends only on divergence being early,
  which follows from the transform's design rather than this workload.

## See also

- [[Compression]] — the pipeline's stages and which of them are lossy
- [[Compression Levels]] — what each level promises, and what it delivers per upstream
- [[Dogfooding Golem]] — the sidecar's opt-in story and where it does pay
- [[Cache Observability]] — the prefix-stability machinery this finding leans on
- Spec Decisions Log: **23** (compression is situational), **31** (the lossy stage is
  gated off on caching upstreams) — decisions live in `docs/golem-spec.md`, not the wiki
