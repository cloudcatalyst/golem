---
task: vibe-authored-history
title: "Vibe seed signals 3 and 4 — code the user provably WROTE, and the voice they write prose in"
state: queued
owner: agent
size: S
discipline: code
design: "`docs/wiki/concepts/Personal Vibe Guide.md` § How it learns names four seed signals. Two shipped with `vibe-personal-style`: seeded exemplars and corrections. These are the other two. The store, the candidate queue and the promotion path all exist and are unchanged — this only adds sources."
gate: "(1) `golem vibe seed --authored <repo>` measures ONLY files with commits by the configured author, and a repo where they authored nothing produces no measurement rather than a measurement of somebody else's code. (2) A prose-voice guideline is derived from the user's own prompt text and is never quoted back verbatim — asserted by a test that feeds distinctive prompt text and checks the guideline contains the derived property, not the sentence. (3) Both remain behind the existing gate: nothing is read or written outside a Golem project."
depends_on: [vibe-personal-style]
touches: [src/vibe/seed.ts, src/vibe/analyze.ts, src/cli/commands/vibe.ts]
created: 2026-09-13
updated: 2026-09-13
---

## Why these two were deferred

`vibe-personal-style` shipped the two seed signals that need nothing new:
exemplars the user points at, and corrections they make to agent-written files.
These two each need a source the vibe module does not currently touch, and
neither is in that task's gate.

## 1. Authored history

Seeding a repository currently measures every source file in it. That is code
*present in the user's checkout*, which is not the same as code they wrote —
vendored files are excluded by the skip list, but a colleague's module, a
generated client, and a file the agent wrote last week all count.

`git log --author` narrows it to what they provably authored. The honest version
is per-file: a file whose commits are all somebody else's should not vote.

Watch for: a fresh clone has full history but a shallow one does not, and
`--author` matching is on a string. Say what was matched and how many files
survived it, rather than silently measuring less.

## 2. Prose voice

The scribe needs the voice the user writes *prose* in — commit messages, docs,
comments — and the strongest available sample is their own prompt text.

**This one is only safe if it derives rather than quotes.** A guide that stores
what the user typed is a transcript in their home directory, and the redaction
path does not make that acceptable. Derive properties — sentence length, whether
they write in fragments, whether they capitalise, how they punctuate lists — and
store only those. The test should prove the distinction by feeding a distinctive
sentence and asserting the sentence does not appear.

## 3. A measurement a LINTER enforces proves nothing about the person

Found on the first real seed (2026-09-13, a 20,313-line JS repo). Three of the
five habits in the brief — `quotes: single`, `semicolons: yes`,
`indent: spaces, width 2` — were enforced by that repo's `eslint.config.js`
(`@stylistic/quotes`, `@stylistic/semi`) and its `.editorconfig`. The guide
reported them with overwhelming evidence (8,238 single quotes against 572) and
the evidence was real, but it measured the toolchain, not the human.

The measurements nobody enforced were the informative ones, and in that repo
they were striking: 33% comment density, only 37% of comments capitalised and
25% punctuated, 75% of files opening with a header comment, and a line-width
spread the config had *deliberately* left unpinned (`max-len` commented out as
"dense lines").

So: when seeding, detect the formatters and linters in the tree
(`eslint.config.*`, `.editorconfig`, `.prettierrc*`, `biome.json`, `rustfmt.toml`,
`setup.cfg`/`pyproject.toml`) and mark every habit they pin as ENFORCED in the
guideline rather than presenting it as a preference. A habit nothing enforces is
worth more than one with ten times the evidence behind it.

Note the subtlety, and do not overcorrect: the human usually WROTE that config,
so it is still their choice — expressed once, deliberately, instead of 8,238
times. Label it, keep it, and rank it below the unenforced habits.

## 4. Exemplar snippets are chosen alphabetically

`seedFromPath` captures the first three readable files, and the walk is sorted,
so the exemplars came from `bench/accuracy.js`, `bench/micro.js` and
`bench/pipeline.js` — whatever sorts first, not what is representative. Pick by
something meaningful instead (median comment density, median file length, or
spread across directories), or let the user name the exemplars.

## Out of scope

Anything that changes the store layout, the gate, the candidate queue, or the
promotion path. All four exist and work; this task adds sources into them.

## Verification bar

The standing one: `npx tsc --noEmit`, `npm run lint`, `npm run format:check`,
`npx vitest run`, plus `golem wiki check` if a wiki page changed.
