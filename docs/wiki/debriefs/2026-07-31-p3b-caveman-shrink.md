---
title: 2026-07-31 — P3b, caveman-shrink measured against Golem's own gate and declined
type: debrief
tags: [tools, benchmark, caveman, ext, negative-result, r8, shipped]
sources: ["docs/plan/verification-notes.md (§107, §100, §89, §87)", "https://github.com/JuliusBrussee/caveman", "npm caveman-shrink@0.1.0", "src/tools/ext-shrink.ts", "src/tools/shrink.ts", "src/cli/program.ts"]
created: 2026-07-31
updated: 2026-07-31
---

# P3b — caveman-shrink, measured and declined

**Verdict: reproducible negative. 53 of 1,089 description tokens (4.9%), no accuracy
change.** Not adopted, not vendored, not wrapped. The question is closed with a number
instead of an opinion.

## Why measure rather than rebuild

`caveman-shrink` is MCP middleware that compresses tool descriptions — the same job
Workstream B built, measured, and rejected (§89: first-sentence trimming saved 56% and
**tripled** false positives). Rebuilding it would have been the third implementation of
one idea. Golem already owned the gate: 27 labelled selection cases, plus R8.S1's
schema-aware render and argument-construction harness that can veto.

So the work was a **seam**, not a shrinker.

## The install and config surface §87 could not find

§87 recorded that the package's install and config are undocumented on the README, and
warned against inventing them. They are documented in the *tarball*:

- `caveman-shrink@0.1.0`, MIT, published 2026-05-01, 4 files, 11,674 bytes unpacked.
- A **stdio MCP proxy**: `npx caveman-shrink <upstream-command> [...args]` spawns the
  upstream server and rewrites `description` in `tools/list` / `prompts/list` /
  `resources/list` responses.
- Config is env-only: `CAVEMAN_SHRINK_FIELDS` (default `description`),
  `CAVEMAN_SHRINK_DEBUG=1`.
- Deliberately untouched in v1: request payloads, and `tools/call` content.
- The transform drops articles, fillers, pleasantries, hedges and leading
  "I'll/you can/let me", with fenced code, inline code, URLs, paths, CONST_CASE,
  dotted calls and version numbers protected by sentinel substitution.

The npm *web* page 403s a plain fetch; `npm view --json` and `npm pack` both work. That
is worth remembering the next time a page refuses to be read.

## The seam

`src/tools/ext-shrink.ts` resolves their `compress.js` from the **user's own install** —
`--shrink-path`, then `GOLEM_CAVEMAN_SHRINK`, then `caveman-shrink/compress.js`, then
the package root. Golem ships none of its bytes and adds no dependency (tier-2 shape,
Decision 53).

The design decision worth keeping: **an unresolvable package is a hard refusal.** The
tempting alternative — fall back to an identity transform — produces a tidy
"0% saved, no accuracy change" row that looks like a measurement of somebody else's
shrinker and is a measurement of nothing.

## The number

27 cases × 3 repeats, chooser `qwen2.5-coder:7b` (`--role drafter`; the tier's
`classifier` model is still not pulled, and `golem bench` now warns about that *before*
scoring rather than after):

| | baseline | caveman-shrink |
|---|--:|--:|
| description tokens | ~1,089 | **~1,036** |
| accuracy | 88.9% | 91.4% |
| false positives | 3 | 3 |
| abstentions | 3 | 0 |

Verdict `NO-MATERIAL-CHANGE` — the harness flags the +2.5 points as within ~1 case.
Per-string savings on Golem's own prose run 1.3%–11.6% of characters; these
descriptions are already terse, and the transform's own protections cover much of the
rest.

## Why 4.9% is still a no

53 tokens is **0.04% of a 139k request**, it lives in the cached prefix at 0.1×, and
collecting it would mean the proxy rewriting tool descriptions in flight — including
other servers' and the client's built-ins, which §100 established are **93.9%** of the
block and not Golem's to rewrite.

There is no accuracy objection to their transform. The objection is that the prize does
not exist. Same shape as §100 and §108: the binding constraint was never accuracy, it
was **ownership and magnitude**.

The mode stays in the harness, so anyone whose catalog is more verbose than Golem's can
run the same gate on their own descriptions in one command.

Related: [[Managed Tools]] — the never-vendor rule this seam obeys; [[Tool Search]] — why the
`tools` block is the most expensive thing to churn; [[Compression]] — the input-side economics
that make 53 tokens a non-prize.
