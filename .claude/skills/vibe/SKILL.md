---
description: Your personal coding style and writing voice — seed it from code you like, see what it holds, and confirm what Golem has noticed. Personal and cross-project, stored under ~/.golem/vibe/, and consulted automatically during coding, writing and review.
invocationMode: user
---

The user's PERSONAL style guide: how they write code, how they format it, and the
voice they use in comments and prose. It lives under `~/.golem/vibe/` — one
guide per human, shared across every Golem project they work on, and readable
only from a Golem-initialised project.

Argument: $ARGUMENTS (a verb, optionally with paths — default: `show`).

## What is in the guide

| path | what it holds | when to read it |
|---|---|---|
| `VIBE.md` | the brief — measured habits + voice | already in context; do not re-read |
| `guidelines/<topic>.md` | the detail behind one habit | when it decides something |
| `snippets/<lang>/<id>.md` | real exemplars with provenance | when matching shape matters |

**The brief is capped and the rest is on demand.** That is the whole design: a
guide can grow for years without growing the cost of every request. Never bulk
read `guidelines/` or `snippets/` "for background" — open one when it settles
an actual question, and say which one you opened.

## Verbs

- **`show`** (default) — run `golem vibe show` and report what the guide
  currently says. If nothing is captured, say so and offer to seed it.
- **`seed <path...>`** — the user is pointing at code that reads the way they
  write. Run `golem vibe seed <path>` for each. It measures indentation,
  quoting, terminators, line width, comment density and shape, and naming, then
  rewrites `guidelines/formatting.md`, captures a few exemplar snippets with
  provenance, and refreshes the measured block of the brief. Report the counts it
  prints — a measurement over twelve lines is not evidence, and the user should
  see which one they got.
- **`quiz`** — ask about what has been noticed but not confirmed.

  1. Run `golem vibe candidates`. It lists ONLY what is worth asking about:
     open, and seen more than once. An empty list means do not ask — say so and
     stop.
  2. Ask about ONE candidate, using `AskUserQuestion`, quoting its evidence
     ("seen 3x across 2 files"). Never work down the list in one turn; a queue of
     questions is how a useful feature becomes a nag.
  3. On yes: `golem vibe confirm <key> --note "<their words>"`. That marks it
     confirmed AND rewrites `guidelines/preferences.md` plus the brief's
     confirmed block. On no: `golem vibe reject <key>` — tombstoned, never
     raised again. If they do not want to answer, leave it open and move on.

  A confirmed preference is an INSTRUCTION; a measured habit is an observation.
  The guide keeps them in separate blocks and so should you.
- **`sources`** — run `golem vibe sources` and list what the guide was seeded
  from, with dates.
- **`sweep`** — `golem vibe sweep` looks right now for edits the user made to
  files you wrote. The hooks already do this after every write and on every
  prompt, so reach for it only when you want to check capture is working.

## How it learns

Golem records the style of every file you write, and re-reads those files later.
A file whose content moved was changed by the HUMAN, and the difference between
the two readings is a correction — the strongest signal there is, because there
is no ambiguity about whether they meant it. Corrections accumulate as
candidates; a candidate seen more than once is what the quiz may ask about.

This runs by itself. Your part is to ask well, at a natural pause, and not often.

## Rules that matter

1. **Personal loses to the project.** A project's committed conventions, and a
   team's synced standards, outrank this guide. When they disagree, follow the
   project and TELL the user about the conflict — never silently resolve it and
   never edit the project to match the personal style.
2. **Measured and confirmed are different things.** The measured block of the
   brief is regenerated on every seed and is counted from real bytes. Everything
   outside it is the human's own words and is preserved verbatim. Do not write
   into the measured block, and do not present a measurement as a preference the
   user has stated.
3. **This is not a formatter.** The guide informs code you are about to write.
   It is never a reason to reformat existing code, and `/vibe` never edits the
   user's project.
4. **Nothing leaves the machine.** The guide is local and personal. Do not copy
   it into a project, a commit, a PR description, or anywhere outward-facing.
