---
title: Personal Vibe Guide
type: concept
tags: [vibe, personal-scope, skills, guidance, context-budget, redaction]
sources: [docs/plan/tasks/vibe-personal-style.md, src/vibe/, src/cli/commands/vibe.ts]
created: 2026-09-13
updated: 2026-09-13
---

# Personal Vibe Guide

A third style scope, below the project's and the team's: **how one human writes
code and prose**. Formatting, naming, comment density and shape, and the voice
they use in comments, commits and docs. It lives in the user's home directory,
follows them across every project, and is consulted automatically when an agent
authors code, prose or a review.

Related: [[Guidance Rules]] · [[Configuration Surfaces]] · [[Redaction Stage]] ·
[[Free and Team Tiers]] · [[Wiki-First Knowledge]].

## Where it lives

`~/.golem/vibe/` — the literal `~/.golem` user scope (spec Decision 19,
verification-notes §17), not an env-paths config dir.

| path | role | when it reaches context |
|---|---|---|
| `VIBE.md` | the brief: measured habits + voice | ALWAYS, on coding/writing/review turns |
| `guidelines/<topic>.md` | the detail behind one habit | on demand, one at a time |
| `snippets/<lang>/<id>.md` | exemplars with provenance | on demand |
| `candidates.jsonl` | observed but unconfirmed signals | never |
| `sources.json` | what the guide was seeded from | never |

**That split is the design.** Only the brief is paid for on every turn, and it is
capped at 4 KiB on write — truncated at a section boundary, since a half-stated
rule is worse than an absent one. Everything else is retrievable, so the guide
can grow for years without growing the prefix of every request. An agent that
bulk-reads `guidelines/` "for background" has defeated the whole mechanism.

## The gate

**Only a Golem-initialised project may read it.** `openVibeStore()` returns null
before touching the filesystem, so a directory that is not a Golem project
performs zero reads — not reads that happen to return nothing. The skill file
being present is NOT the gate: a `SKILL.md` is markdown and can be copied into
any repository.

One sharp edge, and the reason the gate is a function rather than a
`findProjectDir()` call: **the home directory is not a project.**
`~/.golem/settings.json` sits at exactly the path the project marker is looked
for, so an uncapped upward walk from anywhere under `~` finds it — which on a
developer machine is most of the disk. `isGolemProject()` rejects
`found === homedir` explicitly.

## Measured, not guessed

The seeder has no parser — deliberately, since no ML or native dependency may
enter the default install (`CLAUDE.md` hard rules). It counts line-level facts
it can prove: indent kind and width, quote preference, statement terminators,
line-width distribution, comment density and shape, identifier casing, and
whether files open with a header comment. Every rendered row carries its
evidence, so "98% of 4,100 lines" is visibly stronger than "60% of 12".

Two counting rules were bought with bugs, and both are the same mistake —
measuring the lines that are easy to count rather than the ones carrying signal:

- **Indentation is read from code lines only.** A JSDoc ` * ` continuation is
  indented one space, and in a well-commented file those are the majority.
- **Only lines where a terminator was a real choice count.** A bare `}` can never
  take a semicolon; counting it drags every file toward 50%.

## What a measurement does, and does not, prove

**A habit a linter enforces measures the toolchain, not the person.** On the
first real seed (2026-09-13, a 20,313-line JS repo) three of the five habits in
the brief — single quotes, semicolons, 2-space indent — were pinned by that
repo's `eslint.config.js` and `.editorconfig`. The evidence was overwhelming
(8,238 single quotes against 572) and entirely real, and it still said nothing
the config file did not already say out loud.

The informative measurements were the ones nothing enforced: comment density
(33% of lines), comment shape (only 37% capitalised, 25% punctuated), header
comments on 75% of files, and the line-width spread that config had deliberately
left unpinned. **An unenforced habit outranks an enforced one with ten times the
evidence.**

Marking enforced habits as such is tracked in `vibe-authored-history`. Until it
lands, read the guideline next to the repo's formatter config. And do not
overcorrect: the human usually wrote that config, so it is still their choice —
expressed once, deliberately, rather than thousands of times.

## Generated versus human

`VIBE.md` has a generated block bounded by `<!-- golem:vibe-measured:begin -->` /
`:end`. A re-seed replaces that block wholesale and preserves every word outside
it verbatim. Measurements and stated preferences are different things, and the
file has to make which is which obvious — otherwise nobody trusts it enough to
write in it.

## Precedence

`project SOP > team standard > personal vibe`. Where a project's committed
conventions disagree, the project wins and the conflict is **surfaced**, never
silently resolved — the same rule the wiki follows for contradictions. The guide
informs new work; it is not a formatter and never reformats existing code.

## Redaction

Every byte written to the guide is derived from the user's real source files, so
it passes through the pipeline redactor BEFORE the write, never after. There is
no window in which unredacted text exists on disk.

## Surfaces

- `golem vibe show` — the brief, as a turn sees it
- `golem vibe seed <path...>` — measure from files or projects the user names
- `golem vibe sources` — what it was seeded from, with dates
- `golem vibe path` — where it lives on this machine
- `/vibe` — the skill: the same verbs plus `quiz`, which is the only surface
  allowed to write a *stated* preference, because it is the only one that can ask
- the `vibe` guidance rule — seeded by `golem init`, always in context, which is
  what makes the guide passive rather than something to invoke

`/vibe` is the one skill installed WITHOUT the `golem-` prefix, so
`init-skills.ts` carries an `UNPREFIXED_SKILLS` allowlist. Widening the prefix
glob instead would hand Golem authority over directories the user or a team
created — `.claude/skills/` is shared.

## How it learns

The design rests on one fact: **the user's own edits are not tool calls.** A
PostToolUse hook sees everything the agent writes and nothing the human does, so
a hook alone can never see the most valuable signal — the agent wrote X, the
human changed it to Y.

So capture is two halves meeting in a small ledger:

1. **PostToolUse** records a hash of what the agent wrote plus a style reading of
   it, in `.golem/state/vibe-pending.json`. READINGS, never source — which is
   what keeps a second copy of the user's code off the disk and means the
   redaction question never arises there.
2. **UserPromptSubmit** re-reads those files. The human has stopped typing, so
   they have probably stopped editing; a file whose hash moved was changed by
   someone who is not the agent. This is why no file watcher is needed, and it is
   naturally rate-limited to once per human message.

A correction is diffed metric by metric, and **most of `signals.ts` is refusals**.
Each metric states how much evidence it needs on BOTH sides — four quote
characters, four semicolon candidates, ten lines for a width claim, three
comments for a voice claim — because a small file flips its majority on one
edited line, and a candidate raised from that is noise the human then has to
decline. Comment density is bucketed rather than compared as a percentage, so a
two-point move is not reported as a change of mind.

Surviving signals land in `candidates.jsonl` with a count and the distinct files
they came from. `/vibe quiz` may ask only about one `open` candidate seen at
least twice. A `yes` confirms it; a `no` **tombstones** it, and a tombstoned
signal is never resurrected however many times it recurs — which is what makes
the quiz bearable rather than a recurring nag.

The sweep is idempotent: after it runs, the human's version becomes the new
baseline, so sweeping the same edit twice records it once. Without that, one
correction would cross the quiz threshold on its own and the threshold would stop
meaning "this recurred".

## Measured, confirmed, and the difference

`VIBE.md` carries two generated blocks and the human's own prose between them.
The measured block is regenerated on every seed and is an OBSERVATION. The
confirmed block holds preferences the human agreed to, and is an INSTRUCTION. An
agent has to be able to tell them apart, so they never share a block — and the
confirmed block is inserted ABOVE the measured one, because the brief truncates
from the bottom and the stated preferences are what must survive the cap.

## Not yet built

Two of the four seed signals: `git log --author` over a seeded repo (code the
user provably wrote, rather than code merely present in their checkout), and
prompt text as a source for the prose voice the scribe needs.
