---
task: skills-project-scope-reachability
title: "Project-scoped `/golem:*` skills may be unreachable — and a user-scope plugin is currently masking it on one machine"
state: done
owner: agent
size: M
discipline: code
design: "The evidence is the archived R13.16 branch (`D:\\Personal\\Backups\\golem-archive\\R13.16-skills-plugin-user-scope.bundle`, tip `131d1a1`, 2026-08-29) and its commit message. Its user-scope FIX is rejected by decision; its DIAGNOSIS is what this task exists to re-verify. Current installer: `src/cli/init-skills.ts`."
gate: "On a machine with NO `~/.claude/skills/golem/`, a freshly `golem init`-ed project lists every `/golem:<cmd>` skill. Proven by a real listing, not by reading the installer."
depends_on: []
touches: [src/cli/init-skills.ts, src/cli/skills.ts, docs/wiki/]
created: 2026-09-04
updated: 2026-09-04T13:23:41.797Z
---

## The decision this starts from

**Golem skills belong in Golem projects only** (USER, 2026-09-04). A user-scope
install puts them in front of every project on the machine, which is the problem,
not the fix. R13.16's remedy is therefore rejected and its branch archived.

That settles *where* the skills go. It does not settle whether they **work** there.

## What R13.16 found, which is still unanswered

R13.16 was written because **every `/golem:*` skill had become unreachable** —
silently, with no error. Its stated cause:

> `golem init` installed `.claude/skills/golem/<cmd>/SKILL.md` on
> verification-notes §11 (2026-07-03), when directory nesting was how a command
> got namespaced. Claude Code now requires a `.claude/skills/` entry to be a skill
> directory in its own right, so `golem/` read as ONE malformed skill and the
> whole namespace silently vanished from the listing.

`src/cli/init-skills.ts` still writes exactly that nested layout.

## Why this was nearly missed

On the developer's machine as of 2026-09-04, `~/.claude/skills/golem/` exists —
a plugin (`.claude-plugin/plugin.json`, `"version": "0.42.0"`, dated 2026-08-29)
installed by the R13.16 branch. **That is what surfaces the `golem:*` skills**;
the project copy carries no plugin marker.

So the repo looks correct, the skills appear to work, and the two facts are
unrelated. Anyone reading `init-skills.ts` — as happened on 2026-09-04 — concludes
that skills are project-scoped and reachable, and is half wrong.

**Do not remove the user-scope plugin before this task lands**, or the machine
loses every Golem skill.

## VERIFIED 2026-09-04 — the diagnosis is confirmed

Checked against Claude Code's current documentation (client `2.1.259`), recorded
in `docs/plan/verification-notes.md` §150. Discovery is **one level**:

```
.claude/skills/<skill-name>/SKILL.md
ls .claude/skills/*/SKILL.md     # the docs' own check
```

Golem writes **two** — `.claude/skills/golem/<cmd>/SKILL.md` — so
`.claude/skills/golem/` is inspected for a `SKILL.md` that is not there, and the
namespace is silently absent. Not an error, just missing.

### The route that satisfies the decision

A plugin can be **project-scoped**, which is what separates R13.16's rejected fix
from its correct one:

```
claude plugin install golem@<marketplace> --scope project
```

writes to the committed `.claude/settings.json`:

```json
{ "enabledPlugins": { "golem@<marketplace-name>": true } }
```

with a marketplace that is a directory in this repo —
`.claude-plugin/marketplace.json` naming a plugin whose `source` is a local path,
holding `.claude-plugin/plugin.json` and `skills/<cmd>/SKILL.md`. That nesting is
legal because a plugin declares its own skills folder rather than relying on
`.claude/skills/` discovery.

Keeps `/golem:<cmd>`. Stays in the repo. Never reaches another project.

**The alternative** — flat `.claude/skills/golem-<cmd>/SKILL.md` — also works and
is much simpler, but every invocation becomes `/golem-<cmd>`, contradicting
CLAUDE.md's `/golem-<cmd>` convention and every skill reference in the wiki.
That is the trade to decide before writing code.

## What to do

1. **Verify the claim first, and record it in verification-notes with a date.**
   It is a claim about a live external tool from 2026-08-29; Claude Code moves.
   The wiki-first rule and the "verify, don't assume" rule in CLAUDE.md both
   apply — check the current skills documentation before changing any layout.
2. **If it reproduces**, change the layout so a project-scoped skill is reachable
   while keeping the `/golem:<cmd>` invocation and the `golem` grouping. Whatever
   shape wins, it must stay *inside the project*.
3. **Keep provenance working.** `managed-files.ts` records what Golem wrote by
   path; a layout change moves every one of those paths. Migration must not
   orphan the records, or every skill classifies `owned` and can never be
   refreshed again — which is `skill-provenance-on-clone` arriving by a second
   route.
4. **Then, and only then**, remove `~/.claude/skills/golem/` and confirm the
   project's skills still list.

## Out of scope

Reviving R13.16's plugin approach, or any user-scope install. The archive exists
so its diagnosis can be read, not so its fix can be restored.

## Outcome

shipped — flat .claude/skills/golem-<cmd>/ layout; proven live in-session, user-scope plugin removed
