---
title: docs-slider-drift — the check that stops the sixth stale line
type: debrief
tags: [docs, readme, wiki, slider, adr-0004, drift, wiki-check, r12]
sources: [README.md, src/cli/wiki.ts, docs/decisions/ADR-0004-retire-the-slider.md, docs/plan/tasks/docs-slider-drift.md]
created: 2026-08-21
updated: 2026-08-21
---

# docs-slider-drift — the check that stops the sixth stale line

R11.1 retired the slider ([[Compression Levels]]) and R11.4 swept the strings out
of the CLI, the settings help and the installed skills. Neither task listed
`README.md` in its `touches`, so the **front page** went on teaching the retired
control — five lines of it — to every first-time reader. Fixing five lines is ten
minutes. The task was the check that stops the sixth.

## Outcome

`golem wiki check` learned one more rule, the same shape as R11.5's Index rule: a
**retired identifier must not appear in prose that teaches the current system**.
It scans every non-record wiki page plus `README.md`, and it exits 1 on a hit
(verified by reintroducing `golem slider 2` into the README: 1 issue, exit 1).

The sweep it forced was four times bigger than the brief's five lines — **22 hits
across 8 files**, all now clean:

| file | what was wrong |
|---|---|
| `README.md` | forward "at slider level ≤ 1"; "lifecycle by slider level"; `golem slider` listed as a live surface; a hand-written `Golem 0.1.1` in the panel mock-up |
| `docs/wiki/WIKI.md` | the Index still promised "level 0 = passthrough (redaction OFF)" — the exact claim ADR-0004 made unrepresentable |
| `concepts/Redaction Stage.md` | the redaction page named a *dial value* as the way to turn redaction off |
| `concepts/Architecture.md` | a `Slider policy` node, a `slider level 0?` branch, and a retired `level` MCP tool in the tools list |
| `concepts/Configuration Surfaces.md` | `golem slider` in the Runtime row, plus `setSliderLevel` and `cli/slider-read.ts` — **two symbols that no longer exist** |
| `concepts/Dogfooding Golem.md` | a copy-pasteable `golem slider 3` in the Headroom setup instructions |
| `concepts/Compression.md`, `concepts/Cache Observability.md` | prose pinned to "the slider setting" |

## Key lessons

**The exemption list is the whole design.** `slider` appears in 90+ markdown
files; the rule is only useful if it fires on the handful that teach and stays
silent on the ones that *record*. Three mechanisms, all mechanically decidable:

1. **File-level** — dated-record zones are never scanned (`debriefs/`,
   `syntheses/`, `sources/`), and neither are ADRs or `docs/plan/`.
2. **Unit-level record citation** — a unit naming `debriefs/`, `docs/decisions/`,
   `docs/plan/` or `verification-notes.md` is exempt. This is what keeps
   `WIKI.md`'s Index legal: those lines *describe* what a debrief said, and
   rewriting them would falsify the record.
3. **Unit-level retirement context** — a unit naming `ADR-\d{4}`, `R11.x`,
   `retire`, "no longer", "used to", "former" is exempt. Prose is allowed to say
   a thing is gone, and the pages explaining a retirement name it most often.

**Granularity was the hard part, and a whole-section scope would have broken the
primary case.** `WIKI.md`'s Index is one list containing both record descriptions
and live page summaries; scoping the exemption to the section meant one honest
"the slider is retired" line 150 lines away bought a free pass for the drift the
task was filed about. Per-line was too tight the other way — a correctly written
history section fails on its own heading, which carries no marker. What works:
**every list item and table row is its own unit, a paragraph is one unit, and a
heading joins the paragraph beneath it** — except when a heading is followed by a
list, where the items stay independently checked. That last clause is what makes
`## Index` safe.

**A check that fires on correct prose is a check the next agent deletes.** The
retired thing was the *slider*, not levels: `compression` is still a 0–3 dial and
"level 3 (aggressive)" is legitimate live output of `describeDial`. The pattern
therefore knows exactly one word and no `level N` form at all — recorded as a
comment in the table so nobody "improves" it back.

**Code fences are scanned, not stripped** (the opposite of the wikilink rule
above it). `golem slider 3` in a copy-pasteable block is the *worst* drift on a
page, not the most excusable — and it was really there, in the Headroom setup
instructions.

**Two of the brief's five facts were wrong, and checking beat trusting.**
`README.md:74`'s `Level 1 lossless` was filed as "the panel does not render
that": `src/tui/header.ts` renders exactly `Level 1 lossless`, so it stayed.
The version string was the real bug in that mock-up (`0.1.1` vs `0.36.0`) — the
panel does print a version, so the mock-up now shows `<version>` rather than a
number that goes stale at the next release.

**Documentation drift is a leading indicator of dead code.** Two doc lines named
`setSliderLevel` and `cli/slider-read.ts`, neither of which exists any more. The
stale prose was the only surviving evidence of a removal nobody finished
documenting.

## What was deliberately not done

`docs/golem-spec.md`'s body (~66 mentions, a spec rewrite), the VS Code README
(owned by a live workstream, and its line 26 still claims a level disables
redaction), and three stale user-visible strings in code — all filed as
`docs/plan/tasks/docs-slider-drift-remainder.md` rather than left as silent holes.
`PROSE_FILES_OUTSIDE_WIKI` is a deliberate list, not a tree walk, so adding a
surface is an act with a green suite behind it.

`golem plugin` (R8.11) and `golem pkg` (R8.14) were **not** added to the README:
the front page's arc is what Golem is → install → configure, and neither verb is
part of it. A complete command list is not the README's job.

## Where the local model helped

Drafted via the `coder` tool on `qwen/qwen3.7-flash`. It got the *shape* right —
the `RetiredIdentifier` table, the exemption-regex split, the table-driven test
layout — worth keeping. It got the mechanism wrong in ways that matter: an
arbitrary three-line cap in the block splitter, `trim()` on every line (losing the
indentation that identifies a list continuation), a record-citation regex that
required a leading `/` so `debriefs/x.md` at the start of a line never matched,
and — the instructive one — a list test that passed **vacuously** because its
"exempt" item never contained the word `slider` at all. Same trap as the redaction
fixtures: a test that would pass with the feature deleted.

Related: [[Compression Levels]] · [[Configuration Surfaces]] · [[Redaction Stage]] ·
[[Architecture]] · [[Wiki-First Knowledge]]
