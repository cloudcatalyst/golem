---
title: Project Team Binding
type: concept
tags: [team, portal, config, project-scope, entitlement, local-first, unlink]
sources: [docs/golem-spec.md, docs/plan/tasks/project-team-binding.md, docs/plan/verification-notes.md, src/portal/binding.ts, src/portal/entitlement.ts, src/cli/init-team.ts]
created: 2026-09-07
updated: 2026-09-07
---

# Project Team Binding

Which team a project belongs to, where that fact is written down, and what
happens on every path where the answer cannot be confirmed.

Built by `project-team-binding` on 2026-09-07. It is the client half of the
portal's `docs/team-config.md` §4b, and the gate that [[Free and Team Tiers]]
makes the paid line.

Related pages: [[Free and Team Tiers]] · [[Team Layer]] · [[Settings Cascade]] ·
[[Configuration Surfaces]] · [[Portal Install Contract]].

---

## The key, and why it is committed

`.golem/settings.json` — the **committed**, project-scope file:

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

None of it is secret: a public organization identifier and a URL. That is
exactly why it is committed — a colleague who clones the repo is pointed at the
right team before they have run anything.

**Credentials do not follow it.** The OAuth tokens stay per person, per machine,
in the OS keychain (ADR-0003, `team-portal-auth`). The project says which team,
the keychain says who you are, and the two are combined at sync time. A
per-project copy of a token is a credential in a repository waiting to happen.

`portal_url` exists for the machine that has *not* configured a portal: at link
time it is necessarily the same as `portal.url`, but committing it is what lets a
clone reach its team's portal without every member setting one by hand. It is the
API base only — the authorization server is still `portal.issuer` (see
verification-notes §158 for why those are two settings).

## The project, not the machine

A machine-scoped "current team" is wrong the same way a global skills install is
wrong: one setting silently colours every repo, and anyone working across two
teams either has it wrong for one of them or is flipping it by hand all day. One
machine routinely holds repos belonging to different teams, or to none.

The portal reached the same conclusion independently, so this is a shared
decision rather than a proposal. It is also why the offline cache is keyed per
org — `~/.golem/teams/<org_id>.json`, Decision 63 — instead of one `team.json`
that whichever project synced last would answer for.

## The gate is one pure function

`readTeamBinding(settings.team)` returns `unlinked`, `linked`, or `invalid`, and
it performs **no I/O at all**. That is deliberate rather than incidental:
Decision 64's invariant is that a project with no `team.org_id` performs zero
portal I/O, reads no cache and looks up no token, and an invariant is only
checkable if the check that gates it is free. Every caller asks first and does
nothing whatsoever on `unlinked`.

`invalid` is the third state because **nothing here may break anything**. A
malformed `org_id` — a hand-edit, a bad `GOLEM_TEAM_ORG_ID`, a merge artefact —
degrades to the free path with a reason printed, rather than throwing out of
`golem init`.

That validation is a **refusal, not a sanitiser**. Decision 63(e) is right that
sanitising is how two distinct org ids collide on one file; but the id reaches
`teamCachePath` from a text file a human can edit, so a shape that is not a legal
path segment is rejected before any path is built from it. See
verification-notes §159.

## `golem team link` and `golem team unlink`

`link` signs in if needed (delegating to `team-portal-auth`), reads
`GET /api/v1/me`, and **writes the binding at project scope**. One team links
silently; several prompt, or take `--org <id-or-slug>`; `--no-bind` signs in
without touching the project. A team whose subscription has lapsed is still
linked, and told so — entitlement is the portal's question, and refusing to
record a team the user really is a member of would just hide it.

Signing in and binding are reported as **two outcomes**, because signing in can
succeed while binding does not. An unbound project exits 2 — the recoverable
code — so "the keychain knows you but this repo names no team" is never mistaken
for success.

`unlink` is the project-scope inverse. It removes the key and the managed team
skills, and it **keeps** `~/.golem/teams/<org_id>.json`:

| thing | `unlink` does | why |
|---|---|---|
| `team.org_id` (project file) | removes | it is the binding |
| `.claude/skills/golem-team-*` | removes | a team that no longer applies must not leave instructions the agent still follows |
| `~/.golem/teams/<org_id>.json` | **keeps** | machine scope vs project scope: another project may still be linked to that team, and deleting it would take away *that* project's offline policy |
| the OS-keychain token | untouched | one machine, one identity, many projects — forgetting it would unlink every repo on the machine |

`unlink` is **no longer an alias for `logout`**. Until this task shipped it was;
the two undo different things at different scopes, and one word cannot mean both.
`golem team logout` still forgets the machine's token.

## Two failures that look alike

The single most important distinction in the design, decided in exactly one
place (`src/portal/entitlement.ts`) so it cannot drift between call sites:

| the portal says | meaning | what Golem does |
|---|---|---|
| *nothing* — timeout, DNS, offline, `5xx` | **cannot reach** | use the cached team layer, report its age |
| `402 subscription_required` | **not entitled** | do NOT use the cache; fall back to local config, say why |
| `403 not_a_member` | **not entitled** | same, naming the team the project claims |
| `401`, or a refresh that failed | **cannot authenticate** | use the cache, and prompt at the next interactive command |

Stated positively: **the cache is for the case where no verdict was rendered.** A
portal that answered has rendered one, and "you are not entitled" is not a
failure to reach the portal — it is the answer. Stale policy beats absent policy
only when the question is reachability; when the answer is a denial, the cache is
not a fallback, it is the thing being withdrawn.

A `5xx` counts as no verdict — the portal is up enough to answer but has not
answered the entitlement question. An unrecognised thrown error counts as no
verdict too, which cannot become a loophole for a lapsed subscription: a `402`
always arrives as an HTTP response and never as an unknown exception. An
unrecognised **HTTP** answer, though, refuses the cache: if the harness cannot
tell what the portal said, it must not assume the answer was yes.

## Nothing may break

`golem init`'s team step is last, and it has no failure path. Three states:

| state | behaviour |
|---|---|
| `org_id` present, token available | sync, and report what landed |
| `org_id` present, no token | say so, name `golem team link`, **init still succeeds** |
| no `org_id` | mention `golem team link` **once**, carry on |

Every other outcome — offline, lapsed, not a member, malformed key, a sync that
throws — becomes a notice, and `golem init` exits 0. A project must initialise
with no network, no account and no subscription.

`InitReport.notices` exists for this: a thing that is true but is not a file
change, so it has no path and cannot be an `InitAction`. "This project names a
team but this machine is not signed in" is exactly that class of fact.

**Degrade, but never silently.** The hazard is not the degradation — it is
someone believing they are running under team policy when they are not. So every
row above prints a line naming the team, and none of them stops the tool.

## The whole `team.*` section is denied to a remote origin

`team.org_id`, `team.portal_url`, `team.sync` and `team.skills` join
`proxy.bypass_all` and the `portal.*` identity keys on `REMOTE_DENIED_SETTINGS`
(ADR-0008 §The floor). A team origin able to write `team.org_id` could rebind the
project to another organization — a takeover, not a setting — and one able to
write `team.sync` could switch itself back on for a member who deliberately
turned it off.

**A layer must not be the thing that decides it is allowed to be a layer.** The
binding is writable only by a local file, `golem team link`, or `GOLEM_TEAM_*` on
the machine itself.

## What this does not do

Fetching the team layer and writing the cache is `team-layer-fetch`; syncing the
skills is `team-skills-sync`. This task writes and removes the key and names the
cache file, and `golem init` takes the sync as an injected seam — absent, it
reports the honest state ("linked, signed in, nothing fetched yet"); present, it
reports what landed and degrades correctly when it throws. The degradation was
worth building first, because it is the part with a rule rather than a payload.
