---
title: Guidance Rules
type: concept
tags: [guidance, init, claude-code, rules, toggle]
sources: [src/hooks/guidance.ts, src/cli/main.ts, https://code.claude.com/docs/en/memory]
created: 2026-07-16
updated: 2026-07-16
---

# Guidance Rules

How Golem tells Claude how to work in a project: as **Claude Code project
rules**, not as content inside `CLAUDE.md`. (User decision, 2026-07-16; this
supersedes the earlier CLAUDE.md marker-section and CLAUDE.local.md approaches —
see debriefs/2026-07-16-R5.5.md.)

## The model

Each working practice is a named **guidance feature**. Enabling one writes a
rule file that Claude Code auto-loads every session
(verified: https://code.claude.com/docs/en/memory — `.claude/rules/*.md` load at
launch); disabling removes it. **Golem never edits the user's `CLAUDE.md`.**

| Scope | File | Committed? |
|---|---|---|
| project (team-wide) | `.claude/rules/golem-<name>.md` | yes |
| user (personal, this project) | `.claude/rules/golem-<name>.local.md` | no (gitignored) |

**Presence of the rule file is the toggle.** There is no config flag.

### Features (`GUIDANCE_FEATURES` in `src/hooks/guidance.ts`)

Seeded by `golem init` (on by default):
- **ccr-refs** — the oversized-output → CCR-ref swap + how to `expand`.
- **wiki-kb-first** — the wiki → local KB → web ladder ([[Wiki-First Knowledge]]),
  framed as a proactive default.
- **local-coder** — draft non-trivial code with the local `coder` model first.

Opt-in (not seeded; enable when wanted):
- **prompt-translation** — sharpen rough prompts via the local model
  (`golem prompt translate`, show-first, never silent).
- **durable-tasks** — queue interruptible work as durable tasks + explicit
  escalation (`golem task add/run/escalate`).

## Seed-once, per FEATURE (so opt-outs stick AND new rules arrive)

`golem init` seeds each default **once, ever** — once per feature, not once per
project. `.golem/state/guidance.json` records WHICH defaults the project has
been offered:

```json
{ "seeded": true, "features": ["ccr-refs", "coder-first", "vibe", "..."] }
```

Absent rule file, name **in** the record → the user disabled it; leave it alone.
Absent rule file, name **not** in the record → they have never seen it; seed it.
Present rule file → refresh it when unmodified (R9.5), so better wording ships.

`golem uninit` removes all `golem-*` rules (both scopes) and the record.

### Why it is not a bare boolean

It was, until 2026-09-13, and the two facts above were indistinguishable: both
are "sentinel set, rule file absent". So a default was only ever delivered on a
project's *first* init, and **every guidance rule shipped afterwards reached new
projects and silently never reached established ones**. The author could not see
it, because their fresh test project always got the rule. Found by the `vibe`
rule reporting itself "disabled" an hour after it was written
(`guidance-new-default-never-seeds`).

The general shape is worth remembering: *a sentinel that answers "did this
happen?" cannot answer "did this happen to X?"*, and the second question shows
up as soon as the set of X grows.

### Migrating an old record

A pre-2026-09-13 record has no `features`, and the names are not recoverable
from it — so they are inferred from the rules currently on disk, and the rest
are seeded once. That **re-offers a rule somebody had genuinely disabled, one
time**. It is the wrong answer for that user and the right one for everyone who
has simply never been given the newer rules; the second group is far larger, a
missing rule is silent, and a re-offered one is visible in the init output and
one `golem guidance disable` away. The upgrade is announced rather than done
quietly.

## Managing guidance

```
golem guidance list                      # features + on/off (project|user)
golem guidance show <name>               # print a rule body
golem guidance enable  <name> [--user]   # write the rule file (default: project)
golem guidance disable <name> [--user]   # remove it (default: both scopes)
```

Wiring lives in `src/cli/main.ts` (the `guidance` command group) and
`src/hooks/guidance.ts` (`seedDefaultGuidance`, `writeGuidanceRule`,
`removeGuidanceRule`, `removeAllGuidanceRules`). Rule bodies carry a stripped
`<!-- Managed by Golem … -->` banner so they're recognizable in-editor without
costing context tokens.

See also [[Dogfooding Golem]].
