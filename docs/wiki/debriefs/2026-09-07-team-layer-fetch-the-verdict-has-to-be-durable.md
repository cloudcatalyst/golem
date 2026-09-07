---
title: "team-layer-fetch — the verdict has to be durable, not just correct"
type: debrief
tags: [team, portal, config, precedence, entitlement, cache, offline, decision-63, decision-64, adr-0008]
sources: [docs/plan/tasks/team-layer-fetch.md, docs/decisions/ADR-0008-settings-cascade-and-importance.md, docs/plan/verification-notes.md#160, src/portal/team-layer.ts, tests/unit/portal/team-layer.test.ts]
created: 2026-09-07
updated: 2026-09-07
---

# team-layer-fetch — the verdict has to be durable, not just correct

The `team` origin had been a slot since `settings-cascade-importance`: a
`LayerName` value, a rank between `user` and `project`, and
`LoadConfigOptions.teamLayer` waiting for a payload. Nothing fetched one. This
task is the code that puts something in it, and the interesting part turned out
not to be the fetch.

Related pages: [[Team Layer]] · [[Free and Team Tiers]] ·
[[Settings Cascade]] · [[Project Team Binding]] · [[Configuration Surfaces]].

## Outcome

`src/portal/team-layer.ts` is the whole of it, and it decides as little as
possible:

- `GET /api/v1/orgs/{orgId}/settings`, classified through the **existing**
  `entitlement.ts`. No second opinion about entitlement was added anywhere —
  `mayUseCachedTeamLayer` stayed the single answer, and the one case it did not
  cover (below) was fixed by extending durability, not by adding a judgement.
- `enforced: true` → a top-level `"!important"` declaration at `team` rank. The
  wire did not change; only its meaning did (ADR-0008 §Portal consequences).
- cached per org to `~/.golem/teams/<org_id>.json` (Decision 63), storing the
  **wire rows** rather than the translated object, so translation stays
  single-sourced and a cache written by an older Golem is re-translated by the
  current one.
- `golem status` gains one row per cached team, each with its own age (63(c)).
- `golem team sync` is the on-demand fetch; `golem init`'s step-9 seam is filled.
- **the two surfaces that consume it were wired**, because a populated slot
  nothing reads is still inert: `golem proxy run` and `collectStatus` both load
  through `loadConfigWithTeamLayer`, so the proxy runs under its project'"'"'s team
  policy and `golem status` reports the effective config WITH it, naming the
  team as the source. Cache-only, so neither can block or fail — and an
  unlinked project resolves byte-identically either way.
- the resolver was not touched. `LoadConfigOptions.teamLayer` already marks the
  origin remote, so arming `REMOTE_DENIED_SETTINGS` in production meant
  *supplying a real payload*, not writing new enforcement.

## The lesson worth keeping: a verdict enforced on the fetch path is only as current as the last fetch

A team layer is fetched rarely and read on every config load. Those cannot be
the same function — a network round trip behind every `golem` command is the
opposite of local-first, and it would make an offline machine *slower* than an
online one at reading its own config. So the read path is cache-only.

Which quietly breaks Decision 64(d): *"a lapsed licence must not keep exerting
control, and a cache that outlives the subscription is exactly how it would."*
That reads like a rule about the moment of the verdict, and it is easy to
implement as one — a `402` returns no layer and skips the fallback. Correct, and
with no durable effect:

- an org's subscription lapses in March
- nobody runs a sync in that repo again
- every `loadConfig` keeps applying March's policy, indefinitely

The 402 was handled perfectly and changed nothing. **The decision was about a
state, and it had been implemented as an event.**

Fixed by persisting the denial into the cache file (`denied: { code, status,
detail, at }`); the read path refuses a stamped cache with the reason and the
date. A successful sync rewrites the file whole, which clears the stamp, so
re-subscribing needs no repair step. Deleting the file was rejected twice over:
it destroys the explanation a user needs, and a file that vanishes by itself is
indistinguishable from a bug.

`api_error` deliberately stamps nothing. Golem failing to understand its own
portal is not a verdict on anybody's subscription, and persisting our bug as an
organization's policy withdrawal is the same mistake in the other direction.

Generalises past this feature: **any design that separates "refresh" from "read"
has to decide where a verdict is durable, and the answer is not automatically
"the fetch".**

## The contract's own example sets nothing

The portal's `docs/api-contract.md` worked example for this exact endpoint is
`security.redact_secrets` with `enforced: true`. That key **does not exist in
this Golem** — the `security` section is the device/write-surface settings, and
redaction has no on/off key by design (the single exception is
`proxy.bypass_all`, ADR-0004, which is on the deny-list and can never be set by
a team).

Found by writing the example into a test and watching four assertions fail: the
value never landed, provenance stayed `default`. That is the loader behaving
correctly — an unknown key warns and is dropped — but it means an admin copying
the contract's headline example gets a team layer that does nothing, with no
reason given.

The near-miss is the better half of the finding. Had the key been spelled to
actually reach `proxy.bypass_all`, the client would have **REFUSED it loudly**
rather than applied it — the correct outcome, and also not the outcome the
example implies. So the example is wrong in the safe direction, twice.

Recorded as verification-notes §160 item 1, with the fix for the portal side
(use keys that exist and are allowed, and state that the client has a
deny-list). The write-time refusal ADR-0008 asks the portal for is `owner: user`
cross-repo work and was not assumed here.

## Decision 63(f), settled

*Does a sync refresh only the current project's team, or every linked team?*

**The current project's, with `golem team sync --all` as an explicit sweep.**
The two are answers to different questions:

- A sync is a **project-scoped act**. It runs in a repo, reports against that
  repo's team, and an entitlement verdict it receives is about the org that repo
  names. Refreshing a second org silently would produce a `402` with no project
  to report it against.
- "Every linked team" is **not knowable** from the client. The cache directory
  lists teams previously *synced* on this machine, not teams currently *linked*
  by some project on it — and 63(d) guarantees those sets differ, because
  `unlink` deliberately keeps a cache. A sweep also has to fall back to this
  machine's configured `portal.url`, since only the project that names a team
  knows that team's `team.portal_url`.

63(f) worried that only-current leaves a rarely-touched repo's cache quietly
ancient. 63(c)'s per-team age is what makes that visible, and `--all` is the fix
once it is visible. That order matters: see the staleness, then choose to clear
it.

## What the tests actually prove

45 new tests. Two are worth naming:

**Proving absence.** The Decision 64 invariant test writes a cache that *would*
change a setting, then asserts the setting is still at its default with
`layer: "default"`. That is stronger than a call-count spy: a spy proves a
function was not called; the consequence proves the value did not arrive. The
call spies are there too (a scripted `PortalClient` and a token read, both
`not.toHaveBeenCalled()`), and the unlinked load is asserted **byte-identical**
to a plain `loadConfig`.

**Measuring "not applied" against a baseline, not against `false`.** The floor
test sends every `REMOTE_DENIED_SETTINGS` key, enforced, off a real fetch. The
first version asserted each value was `not.toBe(true)` — which is wrong: `team.sync`
and `team.skills` default to `true`, and `portal.url` is a string. So the test
loads the same config with **no** team layer and asserts the denied keys did not
move from that. A deny-list test that assumes what the defaults are will pass for
the wrong reason as soon as one of them flips.

## Unverifiable

No live portal was reachable, so the **wire shape itself is [UNESTABLISHED] as
deployed behaviour**. Every disposition, the query parameters, the response
schema and the sync report are implemented against the portal's committed
`docs/api-contract.md` and exercised against a scripted client — not against a
running service. The first real `golem team sync` against a deployed portal is
the check that has not happened.
