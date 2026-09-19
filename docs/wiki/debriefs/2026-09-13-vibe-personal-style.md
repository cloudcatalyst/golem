---
title: The Vibe Guide — A Personal Style Layer, and Four Bugs Only Running It Found
type: debrief
tags: [vibe, skills, guidance, gating, redaction, context-budget, personal-scope]
sources: [docs/plan/tasks/vibe-personal-style.md, src/vibe/, src/cli/init-skills.ts, src/hooks/guidance.ts]
created: 2026-09-13
updated: 2026-09-13
---

# The vibe guide — a personal style layer

`vibe-personal-style` slice 1: a PERSONAL style guide — how one human writes
code, formats it, and sounds in comments — stored at `~/.golem/vibe/`, seeded
from code they point at, and consulted automatically on coding, writing and
review turns. Not the project's conventions and not a team's: a third scope,
below both.

Pages touched: [[Guidance Rules]] · [[Configuration Surfaces]] ·
[[Redaction Stage]] · [[Free and Team Tiers]].

## The shape, and why it is that shape

The requirement that drove every decision was **"must not bloat the context"**.
A style guide is exactly the kind of artefact that grows forever and is loaded
on every turn, so the guide is split by how often each part is paid for:

| path | role | when it costs tokens |
|---|---|---|
| `VIBE.md` | the brief — measured habits + voice | every coding/writing/review turn |
| `guidelines/<topic>.md` | the detail behind one habit | only when opened |
| `snippets/<lang>/<id>.md` | real exemplars with provenance | only when opened |
| `candidates.jsonl` | unconfirmed observations (slice 2) | never |
| `sources.json` | what it was seeded from | never |

Only the brief is always-on, and it is capped at 4 KiB **on write** — truncated
at a section boundary, because a half-stated rule is worse than an absent one.
The cap is a promise about every future request, so it is enforced rather than
documented.

## Three invariants, each with its own test

1. **Gated.** `openVibeStore()` returns null before touching the filesystem, so a
   directory that is not a Golem project performs *zero* reads. The test asserts
   on the syscalls (via a recording `node:fs/promises` mock) rather than on the
   return value — "it returned null" would pass even if the guide had been read
   and discarded.
2. **Capped.** Asserted on the bytes actually stored, not on the input.
3. **Redacted.** Every write goes through `redactStandaloneText` *before* it
   lands, never after, so the unredacted text never exists on disk. The guide is
   built out of the user's real source files; a style guide is not a reason to
   copy a secret into the home directory.

## `/vibe` installs unprefixed, so the allowlist is explicit

Every other shipped skill lands at `.claude/skills/golem-<cmd>/`, and that prefix
is what `ourSkillDirs()` uses to decide which directories Golem may refresh,
prune and delete. The user asked for `/vibe`, which is outside that convention —
and that is precisely how a skill becomes **installable but not uninstallable**:
install writes it, every later step stops seeing it.

So `init-skills.ts` gained `UNPREFIXED_SKILLS` and a `commandFromDir()` helper,
not a widened glob. `.claude/skills/` is shared with the user's own skills and
with a team's, and a broader match would hand Golem authority over directories it
did not create. The round trip — install, prune, uninit, plus a stranger's
directory left untouched — is the test.

## The lesson: four bugs, none of which a test would have found

All four came from running the thing on real input. The unit tests passed
throughout.

1. **The home directory passed the gate.** `~/.golem/settings.json` is the USER
   scope (Decision 19) and it sits at *exactly* the path `findProjectDir()` looks
   for. So an upward walk from anywhere under `~` finds it — which on a developer
   machine is most of the disk, and the gate meant nothing. Found while
   constructing an isolated-`HOME` smoke test, not by a failing assertion.
   `isGolemProject()` now rejects `found === homedir`.
2. **JSDoc continuation lines poisoned the indent vote.** A ` * ` line is
   indented ONE space to align its asterisk. In a well-commented file those are
   the *majority* of lines, so Golem's own 2-space source reported no agreed
   indent width at all. Indentation is now measured on code lines only.
3. **A bare `}` counted as a semicolon candidate.** It can never take one, so
   counting it dragged every file toward 50%. Counting `};` but not `}` would
   bias the other way, so lines that are only closing delimiters are excluded in
   both directions.
4. **The brief was dated in UTC.** A guide seeded in the evening read as
   yesterday's, which looks like a stale file. Display dates are local now;
   `capturedAt` stays ISO/UTC, where precision beats familiarity.

Two and three are the same mistake: **measuring the lines that are easy to count
rather than the lines that carry the signal.** The analyzer has no parser — that
is deliberate, since no ML or native dependency may enter the default install —
so its entire defence is that it counts only what it can prove and renders the
evidence beside every claim. A row reading "60% of 12 lines" has to be visibly
weaker than one reading "98% of 4,100".

## Also observed: the worktree rule earning itself again

Mid-session, `src/cli/fast-path.ts` and its test appeared modified in a checkout
this conversation had not touched — another session merged PR #194
(`fix/statusline-stdin-leak`) and moved the shared HEAD from
`fix/portal-wire-null-tolerance` to `development` underneath the work in flight.
Nothing was lost, because the work moved to `../Golem-vibe` on its own branch and
staged file-by-file; a `git add -A` would have swept a stranger's diff into this
PR. See `CLAUDE.md` § Multi-agent — this is the shared-HEAD case, observed a
third time.

## Slice 2 — capture, and the watcher that turned out to be unnecessary

The brief said a hook plus the file watcher. Only half of that was needed, and
the half that was dropped is the interesting part.

**A hook cannot see the signal.** The agent's writes are tool calls; the human's
edits are not. So the hook records a hash plus a style *reading* of what the
agent wrote, and something later has to re-read those files and notice the hash
moved. `src/knowledge/file-watcher.ts` was the obvious candidate.

**UserPromptSubmit is a better boundary than a watcher.** The human has stopped
typing, which means they have probably stopped editing — so the edits are all
there, settled, at exactly the moment the hook fires. It is rate-limited to once
per message for free, it needs no debounce, no daemon and no settle heuristic
(the repo already carries two open tasks about watcher settle timing), and it
cannot fire mid-save. The watcher stayed out of it entirely.

### Most of the capture layer is refusals

`signals.ts` reads eight metrics, and the interesting code in each is the
minimum evidence it demands on BOTH sides: four quote characters, four semicolon
candidates, ten lines for a width claim, three comments for a voice claim.
Without those, a file that flips its majority on ONE edited line produces a
candidate, and the human learns to ignore the queue. Comment density is bucketed
rather than compared as a percentage for the same reason — a two-point move is
not a change of mind.

The same instinct drove two other decisions:

- **The sweep re-baselines.** After it runs, the human's version is what
  "unchanged" means. Without that, sweeping one edit twice counts it twice, and
  a single correction crosses the quiz threshold on its own — at which point the
  threshold stops meaning "this recurred", silently.
- **A rejection is a tombstone, kept forever.** A declined preference is never
  resurrected however often it recurs. Re-asking a question the human already
  answered is the failure mode that gets a feature turned off.

### Measured and confirmed must not share a block

`VIBE.md` now carries two generated regions. The measured block is an
OBSERVATION; the confirmed block is an INSTRUCTION. An agent that cannot tell
them apart will treat a coincidence as a rule.

The confirmed block is inserted ABOVE the measured one, and that ordering is
load-bearing rather than cosmetic: the brief is capped and truncates from the
bottom, so appending confirmed preferences would make the most valuable part of
the guide the first thing dropped — silently, and only noticeable later as
worse advice.

### Deferred

Two of the four seed signals: `git log --author` (code the user provably wrote,
as opposed to code merely present in their checkout) and prompt text as a
prose-voice source. Tracked as `vibe-authored-history`. The second is only safe
if it derives properties rather than quoting: storing what the user typed would
put a transcript in their home directory, and redaction does not make that
acceptable.
