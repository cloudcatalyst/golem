---
title: For team skills the cache IS the working tree
type: debrief
task: team-skills-sync
tags: [team, portal, skills, entitlement, provenance, decision-64, managed-files, local-first]
sources:
  [
    docs/plan/tasks/team-skills-sync.md,
    docs/wiki/concepts/Free and Team Tiers.md,
    docs/plan/verification-notes.md,
    src/portal/team-skills.ts,
    src/cli/team-skills.ts,
    src/cli/managed-files.ts,
  ]
created: 2026-09-07
updated: 2026-09-07
---

# For team skills the cache IS the working tree

`team-skills-sync`. A team's `SKILL.md` files land at
`.claude/skills/golem-team-<name>/SKILL.md`, a skill deleted in the portal
disappears locally on the next sync, a skill the user edited is reported and
kept, and a sync where nothing changed writes nothing at all.

Related pages: [[Free and Team Tiers]] · [[Team Layer]] ·
[[Project Team Binding]] · [[Configuration Surfaces]].

---

## What shipped

- **`src/portal/team-skills.ts`** — the wire. `GET /api/v1/orgs/{orgId}/skills`,
  with `?manifest=1` for the hashes-only form. Zod at the boundary, unknown
  fields ignored (contract §5 reserves the right to add them), every failure
  turned into a `TeamLayerDisposition` rather than an exception.
- **`src/cli/team-skills.ts`** — the disk. Manifest first, bodies only for what
  differs, and provenance deciding every write and every delete.
- **`golem team skills`** — `--dry-run`, `--json`. The user-facing entry; the
  `golem init` entry is `init-team.ts`'s existing `syncTeamLayer` seam, which
  `team-layer-fetch` owns.
- **53 new tests** across the two modules.

## The lesson worth carrying: a cache is not always a file

Decision 64's rule is that the cache is for the case where **no verdict was
rendered** — unreachable and `401` may use it, `402`/`403` may not. For the
settings layer that is a file at `~/.golem/teams/<org_id>.json`, and "do not use
the cache" means "do not read that file".

Team skills have no such file. The synced `SKILL.md`s **are** the cache: they
are what a later session reads, and Claude Code loads them whether or not Golem
is running. So the same rule inverts into an action rather than an abstention:

- **unreachable / `401` / `5xx`** → keep the files, and report their age (taken
  from the newest team skill's mtime, so the reading is real rather than
  remembered).
- **`402` / `403`** → **remove them.** Not "decline to refresh" — remove. A
  lapsed subscription that leaves a team's skills installed and loading is
  exactly the free team layer the rule exists to prevent, and unlike a settings
  cache nobody has to read a file for it to keep taking effect.

That asymmetry is not in the task brief and would not have been found by
reading the settings implementation, because in the settings layer "stop using
the cache" and "delete the cache" are different operations and only the first is
correct. Stated generally: **before applying a cache rule, ask what the cache
physically is.** A rule written for a file does not transfer unexamined to a
directory of files the harness does not mediate.

Provenance keeps the withdrawal honest: a skill the user edited is kept as a
conflict even when the subscription lapsed. Billing is not a reason to destroy
someone's work.

## `name` is a path component, so it is refused rather than sanitised

The contract returns a `name` and the client decides the path — which means
`name` is interpolated into `.claude/skills/golem-team-<name>/SKILL.md`. That is
the same shape verification-notes §159 item 2 found on `org_id`, arriving from a
different direction: a remote string used to build a filesystem path. A row
named `../../rules/golem-evil` is a write outside the namespace with a JSON
field as the delivery mechanism.

Same answer as §159, for the same reason: **validate and refuse**, never
sanitise and continue. `isValidTeamSkillName` is `^[a-z0-9][a-z0-9-]{0,63}$`,
checked before any path exists to be escaped; a refused row is reported and
skipped, and never fails the sync. Nothing in the contract constrains the field
today, so this is the client's job and not an assumption about the server's.

## The namespace guarantee is three independent guards, not one

A team skill must never collide with a Golem-shipped or a user-authored skill.
Asserting that once would be a claim; it is built as three:

1. **The prefix.** Every path is built by `teamSkillDirName`, which prepends
   `golem-team-`. `init-skills.ts`'s `ourSkillDirs` already excludes
   `golem-team-*` from prune and uninit, so neither side can reach the other's
   directories even in principle.
2. **The name is refused** (above), so a row cannot spell its way out.
3. **The built path is re-checked.** `teamSkillFile` asserts the resolved file
   sits directly under `.claude/skills/` in a directory carrying the prefix, so
   a future refactor that reintroduces a traversal fails in a test rather than
   in a user's repo.

Beneath all three, provenance: even inside its own namespace the sync will not
overwrite or delete a file it cannot prove Golem wrote. The test that proves it
serves a portal actively trying to reach `golem-ship` and `my-own-skill`; both
land in the team namespace instead and the originals keep their mtimes.

## Committed, not gitignored — and `skill-provenance-on-clone` is why

The task named this the one design question it must not leave implicit.

**Committed**, like every other managed file. That answer was risky a day ago
and is cheap now: `skill-provenance-on-clone` moved the provenance record into
committed `.golem/managed-files.json`, so a clone receives the skill *and* the
hash that accounts for it. A teammate who has never linked gets working team
skills from git; a teammate who has linked refreshes them without every file
classifying as `owned`.

Gitignoring them is worse in both directions: every member would need a portal
round trip before the skills existed at all — a clone broken offline, which is
the opposite of local-first — and CI, which has no keychain, would never see the
standards it is meant to enforce.

The sync also **adopts** a file whose bytes match the portal's advertised hash,
recording provenance without writing anything. Without that step the first
teammate to sync after a clone meets a conflict on every file, which is the
defect `skill-provenance-on-clone` fixed for Golem's own skills arriving by the
same route.

## A no-op sync had to be proved on mtimes

`R11.2`'s session-start index sync is mtime-driven, so a sync that rewrote
twenty byte-identical files every launch would feed it twenty phantom changes —
and would print "up to date" while doing it. So the test stats the files before
and after a second sync and demands the numbers be equal, including the
provenance record's own mtime, and additionally demands that **no body was
downloaded**: the manifest's hashes answered the whole question.

That is why the assertion is on mtimes rather than on log output. The log line a
correct implementation prints and the log line a wasteful one prints are the
same line.

## Drift, still open on the portal side

`docs/api-contract.md` §3 and `docs/team-config.md` §4 still describe
`.claude/skills/golem-team/<name>/SKILL.md` — **nested**, which Claude Code
never discovers. Confirmed still present on 2026-09-07 (verification-notes
§160). The flat path is what shipped; the API is unaffected, since it returns a
`name` and the client decides the path. Filed as `portal-team-skills-path-drift`
(`owner: user`). The task doc's own `gate` line carried the same nested path and
was corrected here.

## Unverified

The live round trip needs a real portal and real credentials: an actual `200`
with a team's skills, an actual `402`/`403`, and the `createPortalClient`
refresh ladder against a live Clerk tenant. Every disposition is tested against
a fake transport and the two degraded local paths were run for real against the
OS keychain (`golem team skills` with no portal configured, and with a portal
but no token — both exit 0 with a printed reason). The end-to-end sync against
`golem.run` remains unverified.
