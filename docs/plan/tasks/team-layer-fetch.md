---
task: team-layer-fetch
title: "Fill the `team` origin — fetch the org's settings, cache them per org to `~/.golem/teams/<org_id>.json`, and let a lost network keep policy"
state: queued
owner: agent
size: M
discipline: code
design: "ADR-0008 (`docs/decisions/ADR-0008-settings-cascade-and-importance.md`) settles WHERE a team value lands and what `enforced` now means; `docs/wiki/concepts/Settings Cascade.md` is the reader-facing version. The wire is the portal repo's `docs/api-contract.md` (`GET`/`POST /api/v1/orgs/{orgId}/settings`) and `docs/team-config.md` §1–§3, summarised in `docs/plan/verification-notes.md` §149 items 3 and 8. The retired two-position ladder is `docs/plan/tasks/team-settings-layer.md` — read its §SUPERSEDED, then do NOT build what the rest of it describes."
gate: "The origin is populated, not just declared: `loadConfig` resolves a real team payload at `team` rank, and `enforced: true` on a key arrives as a `\"!important\"` declaration. Offline is a first-class path — a portal that cannot be reached uses `~/.golem/teams/<org_id>.json` and `golem status` reports its age PER TEAM, asserted with two cached teams present so a single figure standing in for both fails the test (Decision 63); an absent cache falls through to local config, LOUDLY, and NEVER stops the proxy starting. `REMOTE_DENIED_SETTINGS` must be armed for this origin — a payload naming `proxy.bypass_all` is dropped with the existing `REFUSED` warning, asserted against a real fetched payload rather than a constructed one. PLUS the Decision 64 invariant, as its own named test: a project with NO `team.org_id` performs zero portal I/O, reads no cache, looks up no token and nags at most once; and `402`/`403` DROPS team policy (falls back to local) rather than serving the cache, which is reserved for unreachable."
depends_on: [team-portal-auth, project-team-binding]
touches: [src/config/loader.ts, src/cli/, docs/wiki/]
created: 2026-09-06
updated: 2026-09-06
---
## Decision 64 — the free/team boundary this task must hold

**Golem is free and COMPLETE for a solo user.** The team layer is the paid tier:
it ADDS org-wide config, synced skills and shared standards, and never unlocks
something a solo user was denied. Read `docs/wiki/concepts/Free and Team Tiers.md`
before starting; spec Decision 64 is authoritative.

Three rules bind this task specifically:

1. **No link, no team code path.** A project whose committed config has no
   `team.org_id` must perform ZERO portal I/O, read no cache, look up no token,
   and nag at most once. **This is an invariant with its own test** — not a
   default, and not something covered incidentally by another assertion. It is
   what makes "free for solo users" checkable rather than aspirational.
2. **"Cannot reach" and "not entitled" are DIFFERENT STATES.** Unreachable
   (timeout, DNS, offline) → use the cache and report its age. `402
   subscription_required` / `403 not_a_member` → do NOT use the cache; fall back
   to local config and say why. Treating a 402 like a timeout hands out a free
   team layer; treating a timeout like a 402 punishes an offline developer for
   the network.
3. **Nothing here may break anything.** No entitlement outcome may stop the proxy
   starting, fail `golem init`, or fail a build. Every one degrades to local
   config, out loud.

## Why this exists as its own task

`settings-cascade-importance` (shipped 2026-09-06) built the `team` origin as a
**slot**: it has its `LayerName` value, its rank between `user` and `project`,
and `LoadConfigOptions.teamLayer` for an already-resolved payload. Nothing
fetches one, and after `team-settings-layer` was closed as SUPERSEDED nothing
owned fetching one either — `project-team-binding` explicitly puts the fetch and
the cache out of its scope and points at a task that is now retired.

So this is the gap, and it is a gap in ownership rather than in design: the
design is settled by ADR-0008 and the resolver is already built and tested. What
is missing is the code that puts something in the slot.

## What to build

1. **Fetch the org's settings** through whatever `team-portal-auth` exposes. No
   new credential handling here; ADR-0003 is why the token does not live in a
   settings file.
2. **Translate the portal's per-key `enforced: true` into a `"!important"`
   declaration.** The wire format does not change — ADR-0008 §Portal
   consequences chose the `"!important"` syntax partly because it maps 1:1 onto
   the flag the portal already sends. Only the MEANING changed, and the portal's
   copy has to follow.
3. **Cache to `~/.golem/teams/<org_id>.json`,** one file per team, and report
   its age per team. Stale policy beats absent policy. Keyed by org because a
   team link is a property of the PROJECT, so one machine holds projects
   belonging to different teams and a single `team.json` would let whichever
   synced last answer for both (Decision 63). The org id is already
   filename-safe; do not sanitise it, that is how two ids collide on one file.
4. **Hand it to `loadConfig` as `teamLayer`,** with a `source` that names the
   TEAM rather than the cache path where a human will read it — ADR-0008
   requires provenance for a team value to name the team, and that requirement
   predates the ADR.

## The failure rule, which is the actual difficulty

A team link is an enhancement to a local-first tool. **Nothing about it may stop
the proxy from starting.** Unreachable portal → cache. No cache → local config,
said out loud. Expired token → say so, keep running. `project-team-binding`'s
failure table is the precedent and should be matched, not re-invented.

## Out of scope

- The OAuth flow → `team-portal-auth`.
- Writing or removing `team.org_id` in the project's config →
  `project-team-binding`.
- Skills → `team-skills-sync`.
- **Any change to the resolver.** The two bands, `ORIGIN_ORDER`, the deny-list
  and the provenance shape are built and asserted by
  `tests/unit/config-cascade-importance.test.ts`. If this task finds itself
  editing `applyObjectLayer`, something has been misread.
- Importance syntax for env vars or headers — permanently out of scope.

## The floor is not optional

`REMOTE_DENIED_SETTINGS` exists and carries `proxy.bypass_all`, but today it is a
mechanism with no origin using it, exercised only by tests that construct one.
**This task is what arms it in production.** Marking the origin remote is the
whole of that, and it must be marked remote — CLAUDE.md's hard rule governs, and
importance is a dial with no exception.

Per ADR-0008 §Portal consequences the portal must ALSO refuse the denied keys at
write time, so an admin never believes they set something the client drops. That
half is outward and cross-repo (portal at `D:/Personal/Projects/Golem`), so it
needs its own `owner: user` conversation rather than being assumed here.
