---
title: Two Bands, One Ladder — Building the !important Cascade Without Touching a Single Value Shape
type: debrief
tags: [config, settings, cascade, important, precedence, team, adr-0008, redaction]
sources: [docs/decisions/ADR-0008-settings-cascade-and-importance.md, docs/plan/tasks/settings-cascade-importance.md, src/config/loader.ts, src/config/control-surface-types.ts, docs/wiki/concepts/Settings Cascade.md]
created: 2026-09-06
updated: 2026-09-06
---

# Two bands, one ladder — building the `!important` cascade

`settings-cascade-importance` built ADR-0008: every origin may declare
`!important`, and importance reverses origin order. `user!` beats `team!` beats
`project!` beats `local!`, and every important declaration beats every normal
one.

Pages touched: [[Settings Cascade]] (new §Where it lives) · [[Team Layer]]
(unchanged — its mechanism stays retired) · [[Configuration Surfaces]].

## Outcome

Shipped. 21 new cascade tests, 2 new control-surface tests, and — the assertion
that mattered most — **`tests/unit/config-precedence.test.ts` passes
unmodified.** An install that declares no importance resolves byte-identically
to the one it resolved before this existed. That was the regression bar the task
set, and it is the reason none of the existing loader fixtures needed editing.

## What the design got right, and it saved the day

**The syntax decision was load-bearing.** ADR-0008 rejected a value wrapper
(`{"$value": 2, "$important": true}`) in favour of a sibling declaration list:

```json
{ "telemetry": { "enabled": false }, "!important": ["telemetry.enabled"] }
```

That is why this change did not touch `src/config/schema.ts` at all. Every zod
leaf still calls `safeParse` on exactly the shape it parsed before. `loader.ts`'s
merge path already juggles retirement, migration, shadowed renames and per-key
provenance; unwrapping values inside it would have meant editing the subtlest
code in `src/config/` for a feature that does not need to touch values.

## The three things that were subtler than they looked

**1. A declaration must resolve in exactly ONE band.** The obvious shape is "run
the normal pass over everything, then run the important pass over the important
keys". That is wrong in a way tests do not catch: an important key would land in
the normal band first, so its origin's value would briefly be the effective one
at normal rank, and any *provenance consumer* reading mid-resolution — or any
future short-circuit — would see a value that the cascade never actually chose.
The fix is that `buildObjectLayer` splits the `"!important"` list off *before*
either pass runs, so `applyObjectLayer` can skip a key that belongs to the other
band before doing any work at all.

**2. That skip is also what makes warnings correct.** Each key is walked twice —
once per pass — but processed once, so per-KEY warnings (unknown setting,
migration, remote refusal) fire unconditionally and still appear exactly once.
Per-SECTION warnings are the exception: both passes walk the same sections, so
`unknown settings section "x" ignored` is gated to the normal pass. Getting this
backwards produces duplicate warnings, which is precisely the kind of cosmetic
bug that ships.

**3. The floor needed checking twice.** `REMOTE_DENIED_SETTINGS` is tested
against the key as written *and* against the key after rename migration.
Otherwise a renamed alias would be a route for a remote origin to reach
`proxy.bypass_all` under a spelling the deny-list does not carry. CLAUDE.md's
hard rule governs and importance gets no exception: a denied key is dropped with
a loud `REFUSED` warning, never sanitised silently.

## The test that proves the test

Reversal is the whole novelty, and "the strongest origin wins" passes just as
happily against a resolver with the middle of the ladder backwards. So the tests
assert it **per pair** — `user!` > `team!` > `project!` > `local!` — and the
`GOLEM_*` reversal, which amends a shipped decision, gets its own named test
rather than riding along on a general one.

Then the fix was checked the way the last session's lesson says to: **break the
behaviour deliberately.** Changing pass 2 from `[...ORIGIN_ORDER].reverse()` to
`ORIGIN_ORDER` fails four tests. Had it failed only one, the suite would have
been testing the outcome and not the ordering.

## One place, not two

`ORIGIN_ORDER` is a single array that pass 1 reads forwards and pass 2 reads
reversed. Two hand-maintained mirror-image lists is a bug waiting for the next
origin, and the payoff arrived immediately: `IMPORTANT_LOCKED` derives a
control's *recourse* prose from the same array — the origins that can still
override a pinned key are the ones before it in the normal ladder — so the
panel's explanation cannot drift from the resolver's behaviour. `default` is
filtered out of that prose, because it outranks everything and nobody can write
it; naming it would be an answer the reader cannot act on.

## What is deliberately not here

The `team` origin is a **slot**: it has its `LayerName` value, its rank between
`user` and `project`, and `loadConfig`'s `teamLayer` option for an
already-resolved payload. Nothing fetches one.

That exposed a gap worth naming: `team-settings-layer` was closed as SUPERSEDED
the same day, and `project-team-binding` explicitly puts the fetch and the
`~/.golem/team.json` cache out of its own scope by pointing at that retired
task — so the fetch had no owner at all. Filed as **`team-layer-fetch`**.
Retiring a task can orphan work another task delegated to it, and the pointer
does not complain.

Marking an origin remote is what arms the floor, so today the floor is a
mechanism with no origin using it, exercised by tests that construct one.

Env and header importance stay out of scope: there is no syntax for it and
inventing one would be a second grammar for a rare case.

## Lesson worth keeping

**A tooling paper cut cost more time than the feature did.** Python's text-mode
write on Windows turned four edited files CRLF, and `biome check` reported it as
five formatting errors with hundreds of truncated diff lines — which reads like
a formatting catastrophe, not a line-ending one. The tell is the `␍` marker on
every removed line. Write bytes (`open(p, 'wb')`) when scripting edits on this
machine. It also re-proved reminder 3 from the last handoff: run the repo-wide
gate, because a targeted check on the files you touched is exactly what misses
this.
