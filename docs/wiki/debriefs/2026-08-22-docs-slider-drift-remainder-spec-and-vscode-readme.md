---
title: docs-slider-drift-remainder — the spec body, the VS Code README, and the last two stale strings
type: debrief
tags: [docs, spec, vscode, wiki, slider, adr-0004, drift, wiki-check, r12]
sources: [docs/golem-spec.md, vscode-extension/README.md, src/cli/wiki.ts, src/config/ui-model.ts, src/tui/header.ts, docs/decisions/ADR-0004-retire-the-slider.md, docs/plan/tasks/docs-slider-drift-remainder.md, docs/plan/verification-notes.md]
created: 2026-08-22
updated: 2026-08-22
---

# docs-slider-drift-remainder — the spec body, the VS Code README, and the last two stale strings

The predecessor task ([[Compression Levels]], debrief:
`2026-08-21-docs-slider-drift-the-check-that-stops-the-sixth-line.md`) widened
`golem wiki check`'s retired-identifier scan over every wiki page and
`README.md`, and filed this task rather than leave a silent gap: the check's
own allowlist still didn't cover `docs/golem-spec.md` or
`vscode-extension/README.md`, and two code strings had drifted too.

## Outcome

All three named surfaces are clean, verified by running the real check (not
just grep): `golem wiki check` reports **171 pages + 3 docs, 0 issues**.

**The allowlist.** `PROSE_FILES_OUTSIDE_WIKI` in `src/cli/wiki.ts` grew from
`["README.md"]` to add `docs/golem-spec.md` and `vscode-extension/README.md`
— still an explicit, short list by design (a full tree-walk was rejected
before; widening this list is a deliberate act each time, not a default).

**The Decisions Log needed real machinery, verified as necessary rather than
assumed.** The brief allowed adding exemption logic only if the existing
per-unit `RECORD_CITATION`/`RETIREMENT_CONTEXT` rules genuinely failed on
§9. They did: read all 44 slider-mentioning units in the spec's Decisions Log
individually, and most cite a decision number or `verification-notes` by
name rather than the literal `.md`-suffixed path `RECORD_CITATION` requires.
Loosening either regex to pass would have loosened it everywhere — the thing
the brief explicitly forbade ("do not weaken the rule to make a file pass —
clean the file"). Added instead: `decisionsLogStartLine`, a heading-keyed
exemption — any prose unit at or after a `## … Decisions Log` heading
(case-insensitive, any level) is skipped before the existing checks run.
Scoped to one section of one document, not a directory-wide
`RECORD_ZONES` rule, because a single file mixes a live spec body with a
dated log and needs a boundary *inside* it. Three new test cases cover it:
an unexempted mention under the heading is not flagged, the same mention
above the heading still is, and the heading match tolerates any prefix or
heading level.

**The spec rewrite (§1-8) found two staleness bugs the rename pass alone
would have missed.** Two lines referenced a compression level ("`slider ≥4`",
"levels 3-4") that never existed even under the pre-ADR-0004 0-3 scale —
Decision 30 had already collapsed it, so this was older, uncaught drift
riding along with the slider references. One line ("Claude refines
(slider-gated)") described a local-draft feature that Decision 31 **removed
outright**, not renamed — the `coder` tool is invoked explicitly now, never
auto-triggered by a dial — so the fix there was rewriting the claim, not
substituting a term. The ASCII architecture diagram (inside a fenced code
block, which the checker does not strip) had its label changed while
preserving the box's exact character width. §9 itself is untouched, covered
by the new exemption.

**The VS Code README rewrite was grounded in the running code, not the
brief's description of it.** `render.js`/`extension.js` were read before any
prose was touched: the panel already renders a `compression.level` picker
(`off`/`1`/`2`/`3`) and a `proxy.bypass_all` danger prompt — there is no
"slider level 0" left in the implementation, only in the README describing
it. The highest-priority line (per the brief) was "a dangerous change
(slider level 0 disables redaction) asks first" — the exact claim ADR-0004
makes false, since no compression level can disable redaction any more, only
`proxy.bypass_all` can, and it is never the default. While in that paragraph,
found it also conflated two states `levelLabel()` keeps separate per
Decision 56: a **stopped** proxy reads `Passthrough`; a **running** proxy
with `proxy.bypass_all` on reads `Bypass` (still serving and redacting, so
grouping it with "stopped" would misdescribe it). Corrected in the same pass.

**Two code strings, drafted first via the local model (`coder` MCP tool,
routed to `qwen/qwen3.7-flash`) then hand-finished**, per this repo's
delegate-first convention for code changes: `src/config/ui-model.ts`'s
`brevity.level` summary offered `"auto (follow the slider)"`, not a valid
value under ADR-0004 — now lists only the four real ones (`off`/`lite`/
`full`/`ultra`). Its `compression.level` detail string, found incidentally
while in the same table, had a garbled leftover fragment from an earlier
edit ("... until you set it back to auto. ... passthrough belongs to the
slider ...") — wrong twice over, since no level offers passthrough and
bypass is a distinct setting. `src/tui/header.ts:42`'s local `HeaderSegment`
variable was still named `slider` though its label is `"Level"` and it
renders the compression level — a rename-only fix (`slider` → `level`),
confirmed render-identical both by the call site and by `golem status`'s
live output, which is built from the same `StatusReport` the header
consumes.

## What stayed deliberately unfinished

- `src/dashboard/server.ts`'s `slider-level`/`slider-name` DOM element ids —
  owned by workstream R12.6, out of scope for this task by explicit
  instruction. Not user-visible label text, so `golem wiki check`'s prose
  scan does not reach it either way; a real remaining instance of the name,
  just not the class of drift this task was filed to close.
- Stale prose inside `vscode-extension/render.js`'s own code **comments**
  (near `levelLabel()` and the status-bar-item doc comment) still describes
  "slider level 0" even though the code beside it already reflects
  `compression.level`/`bypass_all`. Comments aren't scanned by the checker
  and weren't one of the three surfaces this task named — found while
  grounding the README rewrite, left as an observed-not-filed remainder.

## Verification

`npx tsc --noEmit` → 0. `npm run lint` → 0 (after a follow-up biome
line-wrap fix on the widened `PROSE_FILES_OUTSIDE_WIKI` array).
`npm run format:check` → 0. `npx vitest run` → 0, 230 files passed + 1
skipped (231), 2983 tests passed + 2 skipped (2985) — +3 over the prior
baseline, all new (the Decisions Log heading exemption cases). `golem wiki
check` (built CLI) → 0, `171 page(s) + 3 doc(s), no issues`. Full findings:
`docs/plan/verification-notes.md` §139.

Related: [[Compression Levels]] · [[Redaction Stage]] · [[Configuration Surfaces]]
