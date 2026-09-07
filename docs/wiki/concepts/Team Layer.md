---
title: Team Layer
type: concept
tags: [portal, team, config, precedence, skills, oauth, golem.run]
sources: [docs/plan/verification-notes.md#149, src/config/loader.ts, src/cli/managed-files.ts, docs/plan/tasks/project-team-binding.md, docs/plan/tasks/team-settings-layer.md, docs/plan/tasks/team-skills-sync.md, docs/plan/tasks/team-portal-auth.md]
created: 2026-09-04
updated: 2026-09-07
---

# Team Layer

How "how this company runs Golem" reaches a developer's machine. Everything
Golem resolves today is on one person's disk; the portal is what gives a team
somewhere to put a shared answer.

The portal half is built and its contract is written down. The client half is
this repo's `project-team-binding`, `team-portal-auth`, `team-settings-layer`
and `team-skills-sync`. Facts and provenance: `verification-notes.md` §149.

Related pages: [[Project Team Binding]] · [[Portal Install Contract]] ·
[[Configuration Surfaces]] ·
[[Guidance Rules]] · [[Architecture]].

---

## One team per project

**Which team a project belongs to is a property of the project**, not of the
machine — the same boundary that puts skills in each project rather than in a
global install. A machine-scoped "current team" is wrong for anyone working
across two of them.

So the committed, project-scope `.golem/settings.json` names it:

```json
{ "team": { "org_id": "org_…", "portal_url": "https://golem.run", "sync": true, "skills": true } }
```

A public identifier and a URL — nothing secret, which is why it can be
committed. Clone the repo and you are pointed at the right team before running
anything.

**Credentials do not follow it.** OAuth tokens are per person, per machine, in
the OS keychain (ADR-0003's line). The project says *which team*; the keychain
says *who you are*; the two are combined at sync time. A per-project token would
be a credential in a repository waiting to happen.

## `enforced` means `!important` at the team origin

**Superseded 2026-09-06 by ADR-0008 / Decision 62(c).** This page used to
describe the team layer sitting in the ladder TWICE — once as defaults, once as
enforced keys. That mechanism is retired: it cost two `LayerName` values for one
source, made provenance answer *"which of the two team positions"* instead of
*"the team"*, and generalised to nobody. It was a special case of something more
useful.

What replaced it: **any origin may declare `!important`, and importance reverses
origin order.** Seven origins, most foundational first —

```
default -> user -> team -> project -> local -> env -> override
```

— cascade normally; important declarations cascade in REVERSED order, and every
important beats every normal. So `user!` beats `team!` beats `project!`. Full
design: ADR-0008; reader-facing version: [[Settings Cascade]].

The wire did not change, only its meaning. A row's `enforced` flag maps 1:1 onto
the syntax:

```json
{ "settings": [{ "key": "telemetry.enabled", "value": false, "enforced": true }] }
```

becomes, at the `team` origin,

```json
{ "telemetry": { "enabled": false }, "!important": ["telemetry.enabled"] }
```

- **not enforced** -> a company *default*. `project` sits ABOVE `team` in the
  normal band, so a repo specialising a company default is the expected case.
- **enforced** -> *policy*, in the important band, beating every repo and every
  checkout — but losing to a member's own `~/.golem` important declaration.

That distinction is the whole feature: a redaction rule and a preferred UI colour
are both settings, and only one of them should be a mandate.

**`GOLEM_*` no longer automatically beats an enforced key** — Decision 62(d)
reversed that shipped behaviour, so a file origin's `!important` now outranks
`env`. Note it is a *file origin's* declaration that does so; the team origin is
remote, and the floor below applies to it regardless.

Provenance names the **team**, not just the layer: a team value's `source` reads
`team org_… (portal)`, or `team org_… (cached copy, fetched …)` when it came off
the cache. `C:\Users\me\.golem\teams\org_2abc.json` answers a different
question from *whose policy is this*.

## The floor: keys a remote origin may never set

`REMOTE_DENIED_SETTINGS` in `src/config/loader.ts` is compiled in, never fetched
— a list the remote can edit is not a floor. It carries `proxy.bypass_all`, the
three `portal.*` identity keys, and the four `team.*` keys. A denied key arriving
from the team origin is **DROPPED, not sanitised**, with a warning that names it:

```
team org_…: REFUSED "proxy.bypass_all" — a remote origin may never set it, at any
importance (ADR-0008 floor). The value was DROPPED, not applied.
```

Loud on purpose: a floor that drops quietly leaves an admin believing they set
something they did not. `team-layer-fetch` is what put a real payload in front of
this check — before it, the mechanism existed with no origin using it.

Two of those groups are self-defence rather than policy. `portal.*` denied means
a compromised portal cannot redirect a client to itself; `team.*` denied means a
team layer cannot re-point the project at a different team, or switch its own
`sync` back on after a person switched it off.

## The fetch, and the per-org cache

`team-layer-fetch` (shipped 2026-09-07) fills the origin. The two halves are
deliberately separate functions:

- **`golem team sync`** — and `golem init`'s team step — talk to the portal:
  `GET /api/v1/orgs/{orgId}/settings`, then write
  `~/.golem/teams/<org_id>.json`.
- **every config load** reads that file and nothing else. No socket, no
  keychain, no failure mode.

Collapsing them would put a network round trip behind every `golem` command and
every proxy request. It would also make an offline machine *slower* than an
online one at reading its own config. So the cache is not a fallback bolted onto
a fetch — it is the primary read path, and the fetch is what refreshes it.

**Which team a sync refreshes** is settled by Decision 63(f): the current
project's, because a sync is a project-scoped act that reports against one repo's
team. `golem team sync --all` is the explicit sweep over every team already
cached on this machine.

## Stale policy beats absent policy

The last fetched layer caches to `~/.golem/teams/<org_id>.json`, one file per
team because a machine holds projects belonging to different teams (Decision
63). A machine with no network
uses the last known team settings rather than silently dropping to user
defaults, and the file records when it was fetched so `golem status` can say how
old it is, **per team** — with several caches a single age is a number that
describes none of them (Decision 63(c)). `golem team unlink` deliberately
**keeps** the cache: it is machine scope while the link is project scope, so
another project on this machine may still be using that team's offline policy.

**One exception, and it is the important one.** A cache is for the case where no
verdict was rendered. When the portal *does* render one — `402`, `403` — the
verdict is written into the cache file (`denied`), and the read path refuses to
apply it, with the code and the date. Without that, Decision 64(d) would hold
only until the next config load: nothing on a `loadConfig` asks the portal
anything, so a subscription that lapsed in March would keep enforcing March's
policy until somebody happened to sync. A successful sync rewrites the file and
clears the stamp, so re-subscribing needs no repair. See verification-notes §160.

## The failure rule

> A team link is an **enhancement to a local-first tool. Nothing about it may
> stop the proxy from starting.**

Not a member, subscription lapsed, portal unreachable, token expired — every one
of them names the problem out loud, falls back to local config or the cache, and
carries on. **Degrade, but never silently**: the hazard is someone believing they
are under team policy when they are not.

## An organization is never implied

An access token identifies a *user*. There is no active organization for a
machine client, so every org-scoped call names the org in its path and the server
re-verifies membership on every request — a token outlives a membership, and
someone removed at 09:00 still holds a valid token at 09:05.

`403 not_a_member` is deliberately indistinguishable from an org that does not
exist, so the API cannot be used to enumerate organizations.

Sign-in is authorization code + PKCE (`S256`) over a loopback redirect, because
the harness ships as source and cannot hold a secret. **There is no device grant**,
so a machine with no browser cannot sign in at all — a stated v1 limit, not an
oversight.

## Team skills are a second managed namespace

`.claude/skills/golem-team-<name>/SKILL.md`, separate from Golem's own
`.claude/skills/golem-<cmd>/` so a team skill can never overwrite a personal one
and so ownership is obvious from the path. Per project, so unrelated personal
work does not inherit an employer's skills.

**Flat, one level — corrected 2026-09-07.** The portal's `docs/team-config.md`
and an earlier draft of this page both wrote `golem-team/<name>/SKILL.md`, but
Claude Code discovers exactly ONE level under `.claude/skills/` (the 2026-09-04
skills debrief), so the nested path would never be loaded. `init-skills.ts`
already installs and excludes the flat `golem-team-` prefix; only the prose was
stale. `golem team unlink` clears both shapes anyway — see
[[Project Team Binding]] and verification-notes §159.

**Managed means deletions propagate**: a skill absent from the portal's list is
removed locally, which is what makes it a sync rather than a one-way copy. That
is `pruneRetiredSkills` pointed at a remote list — and it inherits the same rule,
that provenance decides and an edited file is kept.

Which makes `skill-provenance-on-clone` load-bearing here: managed files that
arrive via git used to have no provenance record — it lived in gitignored
`.golem/state/` — and classified as permanently unrefreshable. The record now
lives in committed `.golem/managed-files.json`, so the hash travels with the file
it describes. Golem's own skills hit that once per project; team skills would
have hit it on every member's machine.

## The schema stays here

`src/config/schema.ts` remains the single source of truth. The release ships
`golem config schema --json` output as `config-schema.json`, and the portal
validates team settings against it — so a value the portal accepted cannot be
rejected on a developer's machine, and the portal carries no copy to drift.

The portal never down-converts for an older client: it serves the layer as
written plus the migrations between versions, and the client applies what it
understands and reports the rest. A wrong value delivered confidently is worse
than a missing one reported honestly.
