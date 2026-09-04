---
task: team-skills-sync
title: "Team skills sync into their own managed namespace — and a skill deleted in the portal disappears locally"
state: queued
owner: agent
size: M
discipline: code
design: "The portal repo's `docs/team-config.md` §4 for the design and `docs/api-contract.md` (`GET /api/v1/orgs/{orgId}/skills`, `?manifest=1`) for the wire; summarised in `docs/plan/verification-notes.md` §149 item 6. The local mechanism is `src/cli/managed-files.ts` + `src/cli/init-skills.ts`, unchanged in kind."
gate: "A skill added in the portal appears at `.claude/skills/golem-team/<name>/SKILL.md` on the next sync; a skill REMOVED in the portal is deleted locally on the next sync; a hand-edited team skill is reported and KEPT, never overwritten; and a sync where nothing changed writes no file and touches no mtime (assert on mtimes, not on log output)."
depends_on: [project-team-binding]
touches: [src/cli/managed-files.ts, src/cli/init-skills.ts, src/cli/]
created: 2026-09-04
updated: 2026-09-04
---

## RESOLVED 2026-09-04 — no marketplace; this design stands

The question this section used to hold is answered. A Claude Code marketplace
CAN carry team skills, remotely and authenticated (verification-notes §151), but
plugins and marketplaces are Claude Code's alone while `SKILL.md` is an Agent
Skills spec artifact (§152).

**USER decision, 2026-09-04: harness-agnostic wins.** Golem's own skills moved to
flat `.claude/skills/golem-<cmd>/` for that reason, and team skills follow the
same shape — `.claude/skills/golem-team-<cmd>/SKILL.md`, invoked
`/golem-team-<cmd>`. The `golem:team:<cmd>` form is not reachable without a
plugin and is therefore not on the table.

`init-skills.ts` already excludes `golem-team-*` from both prune and uninit, so
Golem will never delete a team's file. What remains is this task: fetching them.

## Its own namespace

`.claude/skills/golem-team-<name>/SKILL.md` — a flat sibling of Golem's own
`golem-<cmd>` directories, never nested:

- a team skill can never overwrite one of Golem's own, or a personal one
- when a skill misbehaves, which system owns the file is obvious from its path
- `golem team unlink` can remove the whole directory without guessing

Per project, like everything else here, so a member's unrelated personal work
does not inherit their employer's skills.

## Managed means deletions propagate

> *"A skill absent from this list has been removed by the team, and the client
> removes the local file. That is what makes the namespace managed rather than a
> one-way copy."* — `docs/api-contract.md`

This is exactly `pruneRetiredSkills` (`src/cli/init-skills.ts:89`) pointed at a
remote list instead of a compiled-in table, and it inherits that function's rule:
**provenance decides.** A file still byte-identical to what Golem last wrote is
Golem's to delete; one the user has edited is reported as a conflict and left
alone. Removing a team skill must not destroy someone's local edit of it.

## Don't write what has not changed

Every row carries `content_sha256`, and `?manifest=1` returns the rows **without**
`content`. So the sync is: fetch the manifest, compare hashes, fetch bodies only
for what differs. A no-op sync writes nothing and touches no mtimes — which
matters more than it sounds, because `R11.2`'s session-start index sync is
mtime-driven and a sync that rewrote 20 identical files every launch would feed
it 20 phantom changes.

## Read this before starting

`skill-provenance-on-clone` is the same mechanism's clone-time defect: the
provenance record lives in gitignored `.golem/state/`, so a managed skill file
that arrives via git has no hash and classifies as `owned` — permanently
unrefreshable.

**Team skills make that worse, not equal.** Golem's own skills are committed once
by whoever ran `init`; team skills arrive on every member's machine, in every
linked project, and are expected to change whenever an admin edits one. If they
are committed, the clone defect fires for the whole team; if they are gitignored,
every member must sync before the skills exist at all.

Decide that explicitly — committed or ignored — and write the reasoning into the
debrief. It is the one design question this task must not leave implicit.

## Out of scope

- Authoring or editing team skills. That is a portal page.
- Golem's own `.claude/skills/golem/` namespace. Untouched here.
