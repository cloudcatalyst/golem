---
title: A project names its team, and a team that cannot be reached never stops the proxy
type: debrief
task: project-team-binding
tags: [team, portal, config, entitlement, local-first, decision-64, decision-63, unlink]
sources: [docs/plan/tasks/project-team-binding.md, docs/golem-spec.md, docs/plan/verification-notes.md, src/portal/binding.ts, src/portal/entitlement.ts, src/cli/init-team.ts]
created: 2026-09-07
updated: 2026-09-07
---

# A project names its team, and a team that cannot be reached never stops the proxy

`project-team-binding`. The committed `team.org_id` key, the two commands that
write and remove it, and the one function that decides "cannot reach" from "not
entitled". Reader-facing version: [[Project Team Binding]].

Related pages: [[Free and Team Tiers]] · [[Team Layer]] · [[Settings Cascade]].

---

## Outcome

`.golem/settings.json` gains a `team` section (`org_id`, `portal_url`, `sync`,
`skills`), defaulting to unlinked. `golem team link` now writes the binding at
project scope — one team silently, several prompt, `--org` to skip the prompt —
and `golem team unlink` is its project-scope inverse. `golem init` grew a ninth
step that cannot fail. Nothing fetches the team layer yet; that is
`team-layer-fetch`, which this unblocks.

Verified by `golem verify` (exit 0). Two gate items are **unverifiable by an
agent** and are called out below rather than quietly claimed.

## Five things worth carrying

### 1. `unlink` was already taken, by something at a different scope

`team-portal-auth` shipped `golem team logout` with `unlink` as an alias — sign
out, forget the machine's token. This task's gate requires `golem team unlink` to
remove the *project's* key and its team skills.

They are not two names for one act. A machine has **one identity and many
projects**, so forgetting the token unlinks every repo on the machine, while
unlinking a project must leave the other repos — and the sign-in — alone. One
word cannot mean both, so the alias is gone and `logout` keeps its own name. The
`unlink` output says the sign-in is untouched and names `logout`, because a
command that quietly does less than its predecessor did is worse than one that
explains itself.

Worth generalising: an alias added for convenience becomes a **name claim**, and
the next task at a different scope pays for it.

### 2. The invariant is only real if the check that gates it is free

Decision 64's invariant — *no `team.org_id` → zero portal I/O, no cache read, no
token lookup* — sounds like a discipline to maintain at every call site. It
became structural instead by making `readTeamBinding` a **pure function of
already-loaded settings**: no socket, no file, no keychain. Every caller asks it
first and returns on `unlinked`.

The default token probe in `golem init` is passed as an arrow function rather
than a constructed object, so an unlinked project never even builds a credential
store. That is the difference between "we don't call it" and "there is nothing to
call".

And it is asserted the only way that means anything: **spies, with a demand that
none was called** — at the step level and again through a real `golemInit`. A
test that merely checks the notice text would pass a version that phoned home
first.

### 3. "Cannot reach" versus "not entitled", stated positively

The task doc gives a four-row table. Implemented row by row it is four
conditionals that will drift. Stated positively it is one rule: **the cache is
for the case where NO VERDICT was rendered.**

That reframing decided the rows the table does not have:

- **`5xx` → no verdict.** The portal is up enough to answer but has not answered
  the entitlement question, and its own contract says retry-then-report.
- **An unrecognised thrown error → no verdict**, so the cache is allowed. Safe
  not because it is optimistic but for a *structural* reason: a `402` always
  arrives as an HTTP response and can never reach the error classifier.
- **An unrecognised HTTP status → refuses the cache.** If the harness cannot tell
  what the portal said, it must not assume the answer was yes. This is where the
  402 hole would reopen wearing a different hat.
- **A `403` with a code this version does not know → still denies.** v1 may add
  error codes, and a 403 is an authorization verdict however it is spelled.

Both failure directions are separate named tests, because each is a bug someone
would ship: a 402 treated like a timeout is a free team layer granted by a bug; a
timeout treated like a 402 punishes an offline developer for the network.

### 4. Decision 63(e) said the org id needs no sanitising. It was right, and it was answering a different question

63(e): *"The org id needs no sanitising. It is a Clerk identifier (`org_` plus
alphanumerics), already filename-safe, and a sanitiser is how two distinct org
ids collide on one file."*

Both halves are correct — and the value's **provenance is not the portal**. It
reaches `teamCachePath` from a committed text file a human edits, or from
`GOLEM_TEAM_ORG_ID`. An `org_id` of `../../../.ssh/authorized_keys` is a path
traversal with a settings key for a delivery mechanism.

So: no sanitiser (63(e)'s collision argument stands), but a **refusal**. The
shape is checked once, before any path is built from it, and a bad value degrades
to the free path with a printed reason rather than throwing out of `golem init`.
Validate-and-refuse and sanitise-and-continue are different answers to "this
input is wrong", and only one of them can collide two ids onto one file.

### 5. The whole `team.*` section had to join the remote deny-list, not just `org_id`

`org_id` from a team origin is a rebinding of the project to another
organization. That much is obvious. `team.sync` and `team.skills` from a team
origin are subtler and the same shape: they would let a layer **switch itself
back on** for a member who deliberately turned it off.

**A layer must not be the thing that decides it is allowed to be a layer.** All
four keys are denied; `portal.link_timeout_ms` remains the precedent for what
does *not* belong on that list — a convenience with no security weight.

## A drift correction found on the way

`docs/wiki/concepts/Team Layer.md` and the portal's `docs/team-config.md` both
describe team skills as `.claude/skills/golem-team/<name>/SKILL.md`. Claude Code
discovers **exactly one level** under `.claude/skills/`, which the 2026-09-04
skills debrief established the hard way — so that nested path would never be
loaded. `src/cli/init-skills.ts` already implements the flat
`golem-team-<name>/` shape and excludes it from its own pruning; only the prose
was stale.

`unlink` therefore clears **both** shapes: every `golem-team-*` directory (what
is actually installed) and a literal `golem-team/` directory if one exists,
because "leaves nothing behind" has to hold for a directory that is there
whatever wrote it. Recorded in verification-notes §159 with a note for the portal
side.

## Unverifiable by an agent

Stated plainly rather than dropped:

- **The live `GET /api/v1/me` org list, and the interactive several-teams
  prompt.** Both need real portal credentials and a browser. The *choosing* rule
  is pure and fully tested (`chooseOrganization`); what is untested is a real
  response feeding it, and the readline prompt itself.
- **A real OS-keychain hit during `golem init`.** The token probe is injected in
  tests. `team-portal-auth` verified the real keychain path live on this machine
  (verification-notes §158 item 2); this task only asks it a yes/no question.

## Deliberately left undone

- **No fetch, no cache write.** `team-layer-fetch` owns both. `golem init` takes
  the sync as an optional injected seam and reports honestly that nothing is
  fetched yet — the alternative was a reassuring message about a payload that
  does not exist.
- **`golem status` does not yet show per-team cache age.** Decision 63(c) asks
  for it; the cache has no writer, so there is no age to show. `golem team
  status` does report the binding and whether the file is there.
- **Decision 63(f) stays open** — whether a sync refreshes only the current
  project's team or every linked team. Nothing here needed it settled.
