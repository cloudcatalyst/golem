---
task: team-settings-layer
title: "The team settings layer — one remote source that lands in the precedence ladder TWICE, cached so a lost network keeps policy"
state: done
owner: agent
size: M
discipline: code
design: "The portal repo's `docs/team-config.md` §1–§3 is authoritative; wire format in `docs/api-contract.md` (`GET`/`POST /api/v1/orgs/{orgId}/settings`). Summarised in `docs/plan/verification-notes.md` §149 items 3 and 8. The ladder it extends is `src/config/loader.ts`."
gate: "A team key with `enforced: false` is overridden by `.golem/settings.json`; the SAME key with `enforced: true` is not, and overrides `settings.local.json` too. `GOLEM_*` beats an enforced key — assert that explicitly, it is a decision, not an accident. `golem status` names the TEAM as the source for both, and reports how old `~/.golem/team.json` is. With the network down and a cached file present, the enforced key still applies."
depends_on: [team-portal-auth, project-team-binding]
touches: [src/config/loader.ts, src/config/, src/cli/status-collect.ts, src/cli/status-render.ts]
created: 2026-09-04
updated: 2026-09-04
---

## The shape

```
built-in defaults → TEAM (defaults)
                  → user → project → local
                  → TEAM (enforced keys only)
                  → GOLEM_* environment variables
                  → per-request headers
```

**The team layer appears twice on purpose**, and each key is in exactly one of
the two positions, chosen per key by a team admin via the `enforced` flag on the
API response:

- **Not enforced** → a company *default*: above the built-ins, below everything
  a person writes. An admin sets a sensible starting point without taking
  anyone's dial away.
- **Enforced** → *policy*: applied after every file layer, so no settings file
  can override it.

`enforced` is the whole contract. The portal's own words: *"A client that ignores
the flag is not implementing the feature."*

**`GOLEM_*` still wins over an enforced key.** It already wins over every file
layer, and carving out an exception would mean a setting that cannot be worked
around on a machine that is on fire. Do not "fix" this.

## What has to change here

- `LayerName` (`src/config/loader.ts:50`) is
  `"default" | "user" | "project" | "local" | "env" | "override"`. It needs both
  team positions, distinguishable in provenance — an enforced key and a team
  default are different answers to "why is this value what it is".
- Provenance must name **the team**, not just a layer. The control panel already
  renders "locked" rows for env-fixed settings; an enforced team key renders the
  same way with the team as the source, so "why can I not change this" is
  answered on screen rather than in a support conversation.
- `golem status` gains the team, the enforced-key count, and the cache age.

## Offline

Cache the last fetched layer to `~/.golem/team.json`, written and owned by Golem.
A machine with no network uses the last known team settings rather than silently
dropping to user defaults — **stale policy is better than absent policy** — and
the file records when it was fetched so `golem status` can say how old it is.

## Schema and version skew

The harness stays the single source of truth: the portal fetches
`config-schema.json` from a release (`release-portal-assets`) and validates
against it, so a value the portal accepted cannot be rejected here.

The portal **never down-converts**. It serves the layer as written plus the
migrations between the client's version and the stored one; this client applies
what it has — `SETTING_MIGRATIONS` renames a retired key, `RETIRED_SETTINGS`
raises where there is no replacement — and reports the rest via
`POST /api/v1/orgs/{orgId}/settings` with `golem_version`, `schema_version` and
`unknown_keys`.

That report is fire-and-forget: it always answers `{ "recorded": true }`, and
**nothing about a sync may depend on it succeeding.**

## Out of scope

- Writing team settings. Admin edits happen in the portal; this client reads.
- Secrets. Team settings hold none by construction — the portal refuses a
  credential-shaped key at write time (ADR-0003's line). Do not add a local
  decrypt path for something that cannot arrive.

## SUPERSEDED 2026-09-06 — do NOT build this

**ADR-0008 retires the mechanism this task describes.** Decision 62(c), accepted
2026-09-04 and landed in the spec 2026-09-06:

> This REPLACES the "team layer appears twice" mechanism designed in
> `team-settings-layer` and `docs/wiki/concepts/Team Layer.md` — that design is a
> special case of this one and is retired rather than extended.

The two-position ladder cost two `LayerName` values for one source, made
provenance answer "which of the two team positions" instead of "the team", and
generalised to nobody: a project could not use it and neither could a user. Any
origin declaring `!important` meets the same need, for everyone.

Closed as **superseded, not shipped** — nothing here was built and nothing here
should be. The work is `settings-cascade-importance`. The document stays for the
reasoning trail, because an agent picking this up off the ready list and building
a retired design was a live risk until today.
