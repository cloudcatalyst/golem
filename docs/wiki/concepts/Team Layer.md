---
title: Team Layer
type: concept
tags: [portal, team, config, precedence, skills, oauth, golem.run]
sources: [docs/plan/verification-notes.md#149, src/config/loader.ts, src/cli/managed-files.ts, docs/plan/tasks/project-team-binding.md, docs/plan/tasks/team-settings-layer.md, docs/plan/tasks/team-skills-sync.md, docs/plan/tasks/team-portal-auth.md]
created: 2026-09-04
updated: 2026-09-04
---

# Team Layer

How "how this company runs Golem" reaches a developer's machine. Everything
Golem resolves today is on one person's disk; the portal is what gives a team
somewhere to put a shared answer.

The portal half is built and its contract is written down. The client half is
this repo's `project-team-binding`, `team-portal-auth`, `team-settings-layer`
and `team-skills-sync`. Facts and provenance: `verification-notes.md` §149.

Related pages: [[Portal Install Contract]] · [[Configuration Surfaces]] ·
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

## The layer sits in the ladder twice

```
built-in defaults → TEAM (defaults)
                  → user → project → local
                  → TEAM (enforced keys only)
                  → GOLEM_* environment variables
                  → per-request headers
```

Each key is in exactly one position, chosen per key by a team admin:

- **not enforced** → a company *default*, overridable by anything a person writes
- **enforced** → *policy*, applied after every file layer

That distinction is the whole feature: a redaction rule and a preferred UI colour
are both settings, and only one of them should be a mandate.

**`GOLEM_*` still beats an enforced key, deliberately.** It already wins over
every file layer, and an exception would mean a setting that cannot be worked
around on a machine that is on fire. `LayerName` in `src/config/loader.ts` has
neither team position yet.

Provenance has to name the **team**, not just a layer — the control panel already
renders "locked" rows for env-fixed settings, and an enforced team key renders
the same way, so "why can I not change this" is answered on screen.

## Stale policy beats absent policy

The last fetched layer caches to `~/.golem/team.json`. A machine with no network
uses the last known team settings rather than silently dropping to user
defaults, and the file records when it was fetched so `golem status` can say how
old it is.

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

`.claude/skills/golem-team/<name>/SKILL.md`, separate from Golem's own
`.claude/skills/golem/` so a team skill can never overwrite a personal one and so
ownership is obvious from the path. Per project, so unrelated personal work does
not inherit an employer's skills.

**Managed means deletions propagate**: a skill absent from the portal's list is
removed locally, which is what makes it a sync rather than a one-way copy. That
is `pruneRetiredSkills` pointed at a remote list — and it inherits the same rule,
that provenance decides and an edited file is kept.

Which makes `skill-provenance-on-clone` load-bearing here: managed files that
arrive via git have no provenance record (it lives in gitignored `.golem/state/`)
and classify as permanently unrefreshable. Golem's own skills hit that once per
project; team skills would hit it on every member's machine.

## The schema stays here

`src/config/schema.ts` remains the single source of truth. The release ships
`golem config schema --json` output as `config-schema.json`, and the portal
validates team settings against it — so a value the portal accepted cannot be
rejected on a developer's machine, and the portal carries no copy to drift.

The portal never down-converts for an older client: it serves the layer as
written plus the migrations between versions, and the client applies what it
understands and reports the rest. A wrong value delivered confidently is worse
than a missing one reported honestly.
