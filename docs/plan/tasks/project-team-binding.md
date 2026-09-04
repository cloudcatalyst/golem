---
task: project-team-binding
title: "A team-connected project names its team in its committed config — and a team that cannot be reached never stops the proxy"
state: queued
owner: agent
size: M
discipline: code
design: "The portal repo's `docs/team-config.md` §4b is authoritative for the key shape and the failure table; `docs/api-contract.md` §2–§4 for the wire. Both read on 2026-09-04 and summarised in `docs/plan/verification-notes.md` §149 — read §149 first, then the portal docs for detail. ADR-0003 is why the credential does not live in the file."
gate: "Four behaviours, each a test: (1) no `team.org_id` → zero portal I/O and no nag beyond one mention; (2) `team.org_id` present with no token → `golem init` still SUCCEEDS, names `golem team link`, and needs no network; (3) `403 not_a_member` / `402 subscription_required` → the team the project names is reported, local config is used, and NOTHING fails; (4) `golem team unlink` removes both the key and `.claude/skills/golem-team/`."
depends_on: [team-portal-auth]
touches: [src/config/schema.ts, src/cli/, docs/wiki/]
created: 2026-09-04
updated: 2026-09-04
---

> **Rewritten 2026-09-04** after reading the portal repo. The first draft
> required a membership mismatch to REFUSE. That is wrong for a local-first
> tool and is corrected below — see verification-notes §149 item 7.

## Why the project, not the machine

Which team a project belongs to is a property of the project. A machine-scoped
"current team" is wrong the same way a global skills install is wrong: one
setting silently colours every repo, and anyone working across two teams either
has it wrong for one of them or is flipping it by hand all day.

The portal reached the same conclusion independently (`docs/team-config.md` §4b),
so this is a shared decision, not a proposal.

## The key

`.golem/settings.json` — the committed, project-scope file — gains:

```json
{
  "team": {
    "org_id": "org_3IojJ…",
    "portal_url": "https://golem.run",
    "sync": true,
    "skills": true
  }
}
```

None of it is secret: a public identifier and a URL. That is exactly why it is
committed — a colleague who clones the repo is pointed at the right team before
they have run anything.

**Credentials do not follow it.** OAuth tokens stay per person, per machine, in
the OS keychain (`team-portal-auth`). The project says which team, the keychain
says who you are, and the two are combined at sync time. A per-project copy of a
token is a credential in a repository waiting to happen.

## `golem team link` / `golem team unlink`

1. Authenticate if there is no usable token — delegate to `team-portal-auth`.
2. `GET /api/v1/me` lists the teams this person can use. One team links
   silently; several prompt.
3. Write `team.org_id` at **project** scope, then sync settings and skills once,
   so the link is visibly working rather than merely recorded.

`unlink` removes the key **and** the managed `.claude/skills/golem-team/`
directory. A team that no longer applies must not leave its instructions behind.

## What `golem init` does

| state | behaviour |
|---|---|
| `org_id` present, token available | sync, and report what landed |
| `org_id` present, no token | say so, name `golem team link`, **init still succeeds** |
| no `org_id` | mention `golem team link` once, carry on |

A project must initialise without a network. The free path stays the default and
never nags.

## Failure modes — the rule is that there is no failure

> *"A team link is an enhancement to a local-first tool. Nothing about it may
> stop the proxy from starting."* — the portal's `docs/team-config.md`

| situation | behaviour |
|---|---|
| `403 not_a_member` | Name the team the project points at, use local config, do not fail |
| `402 subscription_required` | Same, with the reason named |
| portal unreachable | Use the cached `~/.golem/team.json`, say how old it is |
| token expired | Refresh silently; on failure fall back to cache and prompt at the next interactive command |

**Degrade, but never silently.** The hazard this design is avoiding is someone
believing they are running under team policy when they are not. Every row above
says something out loud; none of them stops the tool.

## Out of scope

- The OAuth flow itself → `team-portal-auth`.
- The resolver work — where a team value sits in the precedence ladder and how
  `~/.golem/team.json` is cached → `team-settings-layer`.
- Syncing the skills themselves → `team-skills-sync`. This task only writes and
  removes the key, and calls whatever those tasks expose.
- Anything about billing, membership or connectors. Those are browser flows in
  the portal, deliberately (`docs/api-contract.md` §6).
