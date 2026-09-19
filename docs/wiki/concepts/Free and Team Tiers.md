---
title: Free and Team Tiers
type: concept
tags: [pricing, team, portal, entitlement, config, local-first, solo]
sources: [docs/golem-spec.md, docs/plan/tasks/project-team-binding.md, docs/plan/tasks/team-layer-fetch.md, docs/plan/tasks/team-skills-sync.md, docs/decisions/ADR-0003-credentials.md]
created: 2026-09-07
updated: 2026-09-07
---

# Free and Team Tiers

Where the line sits between what everyone gets and what a paying team gets, and
why the line is drawn at a **linked project** rather than at a person or a
machine.

Settled by spec **Decision 64** (2026-09-07), which closes the pricing question
[[Architecture]]'s Decision 20 deferred.

Related pages: [[Project Team Binding]] · [[Team Layer]] ·
[[Settings Cascade]] · [[Configuration Surfaces]] · [[Portal Install Contract]].

---

## The short version

**Golem is free and complete for a solo user.** Not a trimmed tier — the whole
product. Redaction, compression, the local knowledge base, routing, the local
model, the panel, hooks and skills all work with no account, no portal, and no
network.

**The team layer is the paid tier.** It *adds* org-wide configuration, synced
skills and shared standards. It never unlocks something a solo user was denied.

That distinction matters more than it looks. A free tier that withholds features
creates pressure to make the free experience slightly worse. A free tier that is
the entire single-player product does not.

## The gate is a linked project

Team behaviour is reachable only when a project's **committed** config names a
team:

```json
{ "team": { "org_id": "org_…" } }
```

Not a machine, and not a person. One machine routinely holds several projects,
and they may belong to different teams — or to none. An unlinked project on a
machine that also holds a linked one behaves exactly as it did before any team
existed.

This is also why the team cache is keyed per org (Decision 63): one machine, many
teams, so one cache file per team.

## The invariant: no link, no team code path

**A project with no `team.org_id` performs zero portal I/O, reads no cache, looks
up no token, and is nagged at most once.**

This is an invariant, not a default — every team task carries a test that asserts
it. That is what makes "free for solo users" a checkable property instead of a
promise. A regression here is not a small one: it would mean an offline,
account-less developer's tool quietly reaching for a network.

## Two failures that look alike and must not be treated alike

The single most important distinction in this design:

| the portal says | meaning | what Golem does |
|---|---|---|
| *nothing* (timeout, DNS, offline) | **cannot reach** | Use the cached team layer, and report how old it is |
| `402 subscription_required` | **not entitled** | Do NOT use the cache. Fall back to local config, and say why |
| `403 not_a_member` | **not entitled** | Same as 402, naming the team the project claims |
| `401`, or a refresh that failed | **cannot authenticate** | Use the cache; prompt at the next interactive command |
| `5xx` | **portal-side fault, not a verdict** | Use the cache — the portal did not judge anything |

The rule that generates every row: **the cache is for the case where no verdict
was rendered.** A `401` is about the credential, not the subscription — the
portal never got as far as judging entitlement — so the cache stands, and it
fails safe: a stale team layer keeps restrictions and unlocks nothing. A `403`
with a code this version does not recognise still denies, because a 403 is an
authorization verdict however it is spelled.

Conflating them fails in both directions:

- Treating a **402 like a timeout** keeps applying cached team policy after the
  subscription ended — a free team layer, granted by a bug.
- Treating a **timeout like a 402** drops an entitled team's policy the moment a
  developer's train enters a tunnel.

So a lapsed licence **drops** team policy rather than preserving it. Stale policy
beats absent policy only when the question is *reachability*. When the answer is
"you are not entitled", the cache is not a fallback — it is the thing being
withdrawn.

## Why a lapsed licence needs a written-down verdict

The read path is **cache-only**: nothing on a `loadConfig` asks the portal
anything. So "a lapsed licence stops exerting control" does not happen by
itself — an org whose subscription ended in March would keep enforcing March's
policy until somebody happened to run a sync.

So a `402`/`403` **stamps the cache**, and every later cache-only read refuses to
apply it, naming the date and the reason. Deleting the file instead was rejected
twice over: it destroys the explanation, and a file that disappears by itself is
indistinguishable from a bug. A successful sync rewrites the file whole, so
re-subscribing needs no repair step.

Only a genuine *not entitled* verdict stamps. An `api_error` must not — Golem
failing to understand its own portal is not a verdict, and persisting our bug as
an organization's policy withdrawal is the same mistake mirrored. Spec Decision
64(d2).

## Testing the guarantee: run the command, not just the unit

Spy-based assertions prove **no portal I/O happened**. They do not prove the
command **answered**. Both are required, and the gap between them shipped a bug:
`golem team status` exited `2` on a default solo install, complaining about
registering OAuth applications, while every free-tier unit test passed — because
they exercised `golem init` and `loadConfig`, never a `golem team *` command on a
machine with no portal configured.

So an assertion about this boundary includes **a real CLI invocation's exit code
on a default install**. That is the surface a solo user actually meets. Spec
Decision 64(c2).

## Nothing here may break anything

Every entitlement outcome degrades to local config and says so out loud. No
entitlement state may stop the proxy starting, fail `golem init`, or fail a
build. That failure rule predates this page and outranks it: a team link is an
enhancement to a local-first tool, and an enhancement that can break the tool is
not an enhancement.

## There is no licence to crack

The portal is the sole authority on entitlement. There is no local licence file,
no key check, no client-side enforcement to defeat — deliberately, because there
is nothing client-side worth defeating. **The paid artefact is the org's data**,
and that lives on the server. Someone who patches out a check gets an empty team
layer.

Credentials follow [[Team Layer]] and ADR-0003: tokens live in the OS keychain,
never in a settings file, a log, or the wiki.

## What this page does not decide

Pricing, seat counting, and trials are the portal's business and are deliberately
not modelled in the harness.
