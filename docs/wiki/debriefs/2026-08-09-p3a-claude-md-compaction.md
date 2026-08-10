---
title: 2026-08-09 — P3a, the CLAUDE.md compaction actuator (and the honest ~1–3%)
type: debrief
tags: [p3a, context-economy, prompt, local-model, caveman, negative-ish-result, shipped]
sources: ["src/prompt/compact.ts", "src/cli/commands/prompt-guidance.ts", "tests/unit/prompt/compact.test.ts", "docs/plan/tasks/P3a.md", "docs/plan/verification-notes.md (§87)", "docs/plan/proposals/r8-context-economy.md (Workstream P, P3a)"]
created: 2026-08-09
updated: 2026-08-09
---

R6.4 shipped a CLAUDE.md **leanness check** — a line count against the cost doc's
"keep it under 200 lines" tip. P3a is the **actuator**: a reviewed rewrite that
makes the file shorter without losing what it instructs.

## The route decision, and the argument that settled it

The task doc left the route open. Route 1 was tier 2 — install Caveman's
`/caveman-compress` and invoke it. Route 2 was tier 3b — Golem's own rewrite on
the `src/prompt/` seam that R5.5 already built.

Route 2, on a collision neither the memo nor the task doc had spotted:

- Caveman's installer does not ship `/caveman-compress` alone. It "drops a skill
  file into your agent" — the **speech skill** — plus a Claude Code hook that
  "writes a tiny flag file each session" so that skill activates invisibly (§87).
- `hasExistingBrevityDirective` (`src/pipeline/brevity.ts`) treats **any**
  case-insensitive `caveman` in the system prompt as "already handled" and stands
  down, deliberately, because two stacked brevity directives are worse than none.
- So installing Caveman to compact one file would have **silently switched
  Golem's own Decision 52 brevity stage off** — trading a repeated output-side
  saving for a one-off input-side one, invisibly.

Two lesser reasons: tier 2 depends on `golem ext install` (R8.14, not built), and
`src/prompt/` already does local, inspectable, shown-never-sent rewriting.

The same collision is now enforced *inside* the actuator: a rewrite that
introduces the word `caveman` where the original had none is rejected and the
original segment kept. Golem must not be able to produce a file that disables
Golem.

## Byte-preservation is a property of the code, not of the prompt

The task's hard constraint — code, commands, paths, URLs and identifiers
byte-preserved — is not delegated to the system prompt, because a 7B drafter
does not reliably honour one (see the numbers below).

1. **Segmentation.** Fenced code, headings and YAML frontmatter are never sent to
   the model at all. The cheapest way to preserve bytes is not to transmit them.
2. **Masking.** Inline code, markdown links, bare URLs, wikilinks, path-shaped
   tokens, filenames, `SCREAMING_SNAKE` identifiers and `$ENV` references are
   replaced with opaque `GOLEMKEEP<n>` sentinels. Deliberately greedy: over-masking
   costs compaction ratio, under-masking risks a reworded path.
3. **Verification.** After the rewrite every sentinel must come back exactly once.
   A dropped, duplicated or invented sentinel discards that segment's rewrite and
   keeps the **original**. A failed rewrite costs compaction, never fidelity.
4. **Blank lines.** A prose segment owns the blank lines separating it from the
   neighbouring heading; the model never reproduces them. They are held back and
   re-attached — the first version welded every paragraph to the next heading.

Nothing is ever written over the target. The proposal goes to `.golem/compact/`,
and `--apply` is a **second, separate command** run after a human reads
`git diff --no-index`. This is the file that instructs every future session.

## The cost side, and why it does not use the model

Decision 52's rule is that a saving is never reported without its cost. The
obvious implementation — ask the local model to judge whether each rule survived —
is the one that disappears exactly when the model is unavailable, and it asks the
model that just wrote the rewrite to grade it.

So the cost measure is deterministic: extract the instruction-bearing lines from
the **original**, then check how many of each line's content words survive in the
rewrite, stemmed to a fixpoint so inflection changes ("weakened" → "weaken") are
not scored as losses. Weak, always computable, and it cannot flatter the rewrite.
The report says so in as many words, and states what is **not** measured: whether
the assistant follows the shorter file as reliably. Nothing here can detect that.

**The first real diff immediately justified the paranoia.** The percentage said
28/28 directives preserved, while the rewrite had quietly turned "check live docs
… **before implementing**" into "check live docs …". One decisive word, dropped,
inside a rule long enough that the ≥60% threshold never noticed. The report now
carries a `partial` line listing rules that cleared the bar but still lost words —
a check that exists because reading the output caught what the metric missed.

## The measured number

On this repo's own CLAUDE.md (58 lines, already well under the leanness threshold):

- **tokens 936 → 904, −32, ~3.4%** on the best run; ~0.7% on a more conservative
  one. Call it **~1–3%**, not the **~46%** Caveman's README claims. The claim is
  not necessarily wrong — it is a claim about a *fat* instruction file, and this
  project's is already lean. The actuator has almost nothing to do here, which is
  the honest finding and the reason the leanness *check* comes first.
- On a prose-heavy 60-line debrief: ~2.1%, with **3 of 5** prose segments rejected
  because `qwen2.5-coder:7b` broke the placeholder rule on dense text. The verifier
  caught every one. That rejection rate is the single most useful number here: a
  prompt-only implementation of "byte-preserved" would have shipped those.

## Scope

New `src/prompt/compact.ts` + `golem prompt compact [file] [--apply|--out|--role|
--print|--json]`. No `src/interfaces/` change, no proxy-path change, no new
dependency. +17 tests (2394 → 2411 green); tsc, `biome check`, `verify:deps` clean.

Related: [[Compression]] · [[Managed Tools]] — and R6.4's check, which this
actuates. §87 is the source for every Caveman fact above; nothing was copied.
