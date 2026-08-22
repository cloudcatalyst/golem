---
title: redaction-path-uuid — a hex chunk is now clean enough to be a path
type: debrief
tags: [redaction, t-c3, pipeline, entropy-heuristic, false-positive, uuid, worktree, scratchpad, r12]
sources: [docs/plan/tasks/redaction-path-uuid.md, src/pipeline/redaction-rules.ts, tests/unit/pipeline/redaction-audit.test.ts, docs/plan/verification-notes.md#§140]
created: 2026-08-22
updated: 2026-08-22
---

# redaction-path-uuid — a hex chunk is now clean enough to be a path

## Outcome

Fixed. `isPathLikeToken` (`src/pipeline/redaction-rules.ts`) now treats a pure-hex
chunk as clean, alongside the pre-existing pure-alpha/pure-numeric chunks, gated by
a 3-chunk floor (`MIN_CHUNKS_FOR_HEX_ALLOWANCE`). A path containing a UUID or hash
segment — the session scratchpad path
(`AppData/Local/Temp/claude/…/<uuid>/scratchpad`) and `.claude/worktrees/agent-<id>/`
— now survives the pipeline intact, in both `/` and `\` separator spellings, and
every existing entropy/redaction fixture (140 pipeline tests, 2987 tests project-wide)
still passes. Full write-up: `docs/plan/verification-notes.md` §140. Companion
reference for readers who hit the symptom again: [[Redaction Path Placeholders]].

## Why this was safe, not just narrow

The task's hard constraint was that "redaction must never be weakened" is not
suspended for this fix. The argument that makes the change safe is a **call-order
invariant**, not merely the chunk-count guard bolted on top of it:
`isHighEntropyToken` already excludes a token that is pure hex **in its entirety**
(dehyphenated) before it ever calls `isPathLikeToken`. So by the time a token
reaches `isPathLikeToken`, if it contains a hex chunk, at least one OTHER chunk in
that same token must already be something other than clean hex — either a genuine
word, or a mix with a letter outside `a-f` — because otherwise the whole-token
exclusion earlier in the same function would already have disposed of it. The
3-chunk floor is real defense-in-depth on top of that (it also matches every real
path shape in scope: a directory prefix plus a UUID/hash leaf), but the invariant is
what makes the reasoning airtight rather than merely plausible, and it is written
into the code comment the way §49's reasoning is, per the task brief's explicit ask.

## What the tests had to prove, and how they were built

The adversarial requirement: a hyphenated, hex-looking-but-random secret must still
redact, because a real secret can contain hyphens and hex is a subset of the
candidate charset. Covered two ways — a 2-chunk `word-hexlike` pair (one chunk short
of the floor) and a 4-chunk token where every chunk mixes a digit with a
non-`a-f` letter (so no chunk is clean under any of the three rules) — both still
redact.

All random material is built at **runtime**, never a literal: a Fisher-Yates
shuffle over known character pools gives deterministic entropy (all-distinct
characters means Shannon entropy is exactly `log2(N)`, independent of which
characters were drawn, so the fixture is not flaky), and pools for
"letters outside a-f" are built via `charCodeAt` iteration rather than any literal
string of 20+ letters — for a very concrete reason (next section).

## The live reproduction that justified being that careful

While drafting the tests, a genuinely random 40-character mixed-case string —
built programmatically, no literal, no copy-paste — came back through this
session's own tool output as `[REDACTED:high-entropy:N]`. This is this dev
environment dogfooding its own redaction pipeline on its own traffic: the string
independently satisfied the entropy-candidate shape (32–128 chars, ≥2 of 3
character classes, ≥4.2 bits/char), and Golem's proxy redacted it before it reached
the model, exactly as designed — just triggered by a plain string instead of a
path. Reproduced again, deliberately, as part of the end-to-end verification below
(the negative control), and again while retyping a scratchpad path copied forward
from earlier tool output into a new command — the exact "copy-forward is poisoned"
mechanism the task brief's Third-sighting section names, caught live from the
authoring side. Both are recorded in verification-notes §140 and in
[[Redaction Path Placeholders]] as the practical playbook: measure the file on
disk (`grep -c`, `wc -c`, `md5sum`) before believing a write failed, and never
retype a path that has already passed through a tool-output view.

## Verification

All five gate commands by exit code, plus the pipeline-scoped run and an actual
end-to-end round trip through a rebuilt, restarted proxy (not unit tests alone):

- `npx tsc --noEmit` — exit 0
- `npm run lint` (`biome check .`) — exit 0, 561 files, no fixes
- `npm run format:check` (`biome format .`) — exit 0, 561 files, no fixes
- `npx vitest run` — exit 0, 230 test files passed / 1 skipped (231), 2987 tests
  passed / 2 skipped (2989)
- `golem wiki check` — exit 0, 172 pages + 1 doc, no issues
- `npx vitest run tests/unit/pipeline` — exit 0, 9 files / 140 tests (28 in
  `redaction-audit.test.ts`, 7 new)
- End-to-end, after `npm run build` + `golem proxy restart`: fresh UUIDs generated
  at runtime (never copied from earlier tool output), written to disk, ground
  truth measured (`wc`, `grep -c REDACTED`, `md5sum`) before ever viewing the
  round-trip `cat` output, for both real path families and for the same UUID
  spelled both `/` and `\`. All three came back byte-identical to ground truth,
  zero placeholders. A genuine random 40-char secret, run through the same rebuilt
  pipeline as a negative control, still came back redacted.

## What was deliberately left alone

Per the task's "Out of scope": the rule table, the reversible-redaction map
(R9.3's `redactReversibleText`), `ENTROPY_THRESHOLD_BITS`, and the candidate
charset. No allowlisting of scratchpad/worktree directories by path — the task
brief was explicit that a path-shaped allowlist only helps the two families
already noticed and goes stale.

## One process note worth keeping

The `coder` MCP tool's first call (grounded, targeting
`openrouter:qwen/qwen3.7-flash`) hit a transient `429 Too Many Requests`, and a
retry with an explicit `target: "anthropic"` failed differently
(`target "anthropic" declares no model, so there is nothing to ask`). Retrying
without an explicit target and `ground: false` succeeded. Recorded here rather
than in verification-notes since it is a one-off availability hiccup, not a
finding about the system's behaviour.

## See also

[[Redaction Stage]] — the rule table + entropy-backstop reference this task
extends (§31/§37/§49/§50/§140). [[Redaction Path Placeholders]] — the reader-facing
playbook this task's "Note for whoever fixes it" section asked for, including the
reversible-vs-standalone placeholder asymmetry.
