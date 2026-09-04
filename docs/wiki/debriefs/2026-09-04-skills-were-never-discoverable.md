---
title: The Skills Were Never Discoverable — A Layout That Silently Vanished, And The Plugin That Hid It
type: debrief
tags: [skills, init, claude-code, provenance, portability, verification]
sources: [src/cli/init-skills.ts, src/cli/skills.ts, docs/plan/verification-notes.md, docs/plan/tasks/skills-project-scope-reachability.md, docs/plan/tasks/team-skills-sync.md]
created: 2026-09-04
updated: 2026-09-04
---

# The skills were never discoverable

Related pages: [[Release Pipeline]] · [[Team Layer]] · [[Guidance Rules]].

The session opened with a design instinct — *Golem's skills should live in Golem
projects, so they don't show up in unrelated ones* — and an answer that read the
installer, saw `.claude/skills/golem/<cmd>/SKILL.md` being written into the
project, and reported that this was already the case with no cross-project bleed.

Both halves of that answer were wrong, in opposite directions.

## What was actually true

**The project skills were unreachable.** Claude Code discovers exactly one level:
`.claude/skills/<name>/SKILL.md`. Golem wrote two, so `.claude/skills/golem/` was
inspected for a `SKILL.md` that was not there and the whole namespace was absent
from the listing. No error. The layout came from verification-notes §11
(2026-07-03), when directory nesting *was* how a command got namespaced; the tool
moved and the repo did not.

**And the skills that did work were user-scope.** `~/.claude/skills/golem/`
existed — a plugin, `.claude-plugin/plugin.json`, `"version": "0.42.0"`, dated
2026-08-29 — installed by an unmerged local-only branch (R13.16) written
precisely because *every `/golem:*` skill had become unreachable*. So the
`golem:*` names in the session listing came from a machine-wide install, offered
in every project on the machine. **Exactly the leak the session set out to
prevent**, sitting there the whole time.

The two facts were unrelated, which is why reading the installer got the code
right and the machine wrong.

## How it surfaced

Not by looking for it. The branch was found while cleaning up local-only branches
before deleting them, and would have been archived unexamined as "superseded by
decision — we want project-scoped skills" if its commit message had not been
read. It carried the diagnosis.

**Generalisable: a rejected fix can carry a correct diagnosis, and deleting the
branch deletes both.** The archive README and
`skills-project-scope-reachability` exist to separate them.

## The decision, and the one that was nearly made on a false premise

R13.16's *fix* — a user-scope plugin — was rejected outright. Its *diagnosis* was
verified against Claude Code's current docs (§150) and confirmed.

Then a near-miss. A plugin can be **project**-scoped (`--scope project`,
`enabledPlugins` in the committed settings), and a marketplace can be a remote
authenticated URL with `headersHelper` minting a bearer from the OS keychain
(§151) — an elegant fit for team skills, and briefly the recommendation. The user
pushed back toward harness-agnostic, and asked whether flat `golem-<cmd>`
directories could still present as `golem:<cmd>`.

They cannot (§152): for project skills the **directory name is the command** and
frontmatter `name` is only a display label; the `:` namespace belongs to plugins.
Answering that honestly — rather than proceeding on the assumption in the request
— is what settled the design:

> `SKILL.md` is an Agent Skills spec artifact. `plugin.json` and
> `marketplace.json` are Claude Code's alone.

Flat costs the colon and buys portability. That is the trade, and it is not about
aesthetics.

## What shipped

- `.claude/skills/golem-<cmd>/SKILL.md` → `/golem-<cmd>`, 20 skills
- **`migrateNestedSkills`** — retires the old tree, provenance-gated. A skill the
  user edited is reported and KEPT, and the namespace directory is removed only
  when nothing of theirs remains in it: a bare `rm -r` would have deleted the
  file the conflict had just promised to keep
- `golem-team-*` excluded from prune and uninit, so team skills are never Golem's
  to delete — settling `team-skills-sync`'s shape at the same time
- 93 command renames across 38 files of **live guidance only**. Dated records —
  `verification-notes.md`, the debriefs — were left alone, because rewriting
  `/golem/x` in a 2026-07 entry would falsify what was true then

## The bug the tests caught that the tests nearly missed

The targeted init tests passed while `golem status` still probed the old nested
path — writer changed, reader not. It would have reported *skills installed:
false* on a correctly-initialised project forever, and the status line said
`/golem/*` too.

R13.13's debrief already names this class: *a display branch that re-derives a
fact the collector already knows will eventually disagree with it.* It reappeared
within a fortnight, which suggests the lesson needs a mechanism rather than a
memory. **The full suite is the gate; a targeted run is a convenience.**

## Verified live, which is the part that matters

The skill listing refreshed inside the session that made the change: all 20
present as `golem-<cmd>`, `~/.claude/skills/golem` gone, `golem status` reporting
`[ok] /golem-* skills installed`. Not a claim about a layout — the harness
listing it.
