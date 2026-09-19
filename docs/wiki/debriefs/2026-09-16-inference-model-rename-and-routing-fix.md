---
title: The inference.default_target -> inference.model rename that was half-shipped, and the routing bug it was hiding
type: debrief
tags: [config, schema, migrations, routing, targets, proxy, bugfix, incident]
sources: ["src/config/schema.ts", "src/config/migrations.ts", "src/config/loader.ts", "src/cli/proxy-build/upstream-resolution.ts", "src/cli/commands/mcp-serve.ts", "src/providers/target-settings.ts"]
created: 2026-09-16
updated: 2026-09-16
---

# The inference.default_target -> inference.model rename that was half-shipped, and the routing bug it was hiding

Related: [[Fix tuple/array type mismatch in extra_headers property]]

## Outcome
`inference.default_target` (and the deprecated `proxy.default_target`) is now
consistently `inference.model` / `proxy.model` across the whole codebase —
schema, every call site, the backward-compat migration table, and tests. A
genuine, independent routing bug was found and fixed along the way: a named
target could be silently ignored in favour of the legacy upstream path.

## What actually happened
Commit `4b28b87` ("fix: enhance DeepReadonly type to preserve tuple types in
extra_headers property") did two unrelated things in one commit: the tuple-type
fix its message describes, **and** a silent rename of the `default_target`
config leaf to `model` in `src/config/schema.ts`. Nothing else was updated to
match. That landed on `development` as `fc0ba70`'s parent, already broken —
27 files (`mcp-serve.ts`, `gateways.ts`, `upstream-resolution.ts`,
`target-dispatcher.ts`, tests, ...) still referenced the now-nonexistent
`default_target`, failing `tsc --noEmit`.

The user's own attempted fix (today, uncommitted, on `development`) was
**correctly trying to catch those call sites up to `model`** — just
incomplete, and it read as "I broke the project" because the working tree
went red. A separate, more complete attempt already existed too: a stash
("stash before verify", `stash@{0}`) sitting on branch `prepare-release-v0.54.0`
from earlier the same day, well-commented, closer to done but still missing
`src/config/migrations.ts` and with two bugs of its own.

**The reviewing session (this one) initially made it worse**: seeing an
uncommitted diff that looked like an in-progress rename, it was reverted
wholesale back to `default_target` — the wrong direction, since `schema.ts`
had already committed to `model`. `golem verify` staying red after the revert
was the tell; re-reading `schema.ts` directly (not trusting the diff's own
framing) is what caught the mistake.

## The real bug (independent of naming)
In `src/cli/proxy-build/upstream-resolution.ts`, `resolveProxyUpstream()`
always resolved the upstream via the legacy/gateway path
(`resolveActiveUpstream()`) and only merged in the live default-target value
**afterward**, for a downstream warning check — never to actually pick the
upstream. `settings.proxy` structurally satisfies `TargetRegistrySettings`
(it happens to carry the deprecated leaf), so passing it where a fully-merged
settings object was intended type-checked fine and silently discarded the
live target. Two call sites in `src/cli/commands/mcp-serve.ts` had the same
shape of bug. Fix: resolve the target registry first; if a real, non-default
target is named, build the `ResolvedUpstream` directly from it; fall through
to the legacy path only when none is named.

Applying the stash surfaced two more bugs it introduced:
- `src/config/migrations.ts` had renamed the migration table's **FROM-side**
  literal (what an on-disk settings file might still say) from
  `"proxy.default_target"` to `"proxy.model"` — but `proxy.model` is itself a
  live schema leaf now, so that row became unreachable and a real file still
  naming the old key would have silently fallen through to "unknown setting
  ignored." Migration FROM-literals describe history on disk, never the
  current schema; they don't get renamed just because the schema moved on.
- `src/config/loader.ts` had a **cross-section migration bug**: forwarding
  `proxy.active_account`/`proxy.default_target` to `inference.model` resolved
  the leaf, wrote the value, and ran the shadow-key check all against the
  *origin* section instead of the *target* section — since `proxy.model` is
  also a valid (deprecated) leaf, the value could land in the wrong place
  with wrong provenance.

## Lessons
- **An unrelated-sounding commit message is not proof the diff is narrow.**
  `4b28b87`'s message was entirely about `extra_headers` tuple types; the
  schema rename inside it had zero test or doc coverage and was invisible
  until every downstream file started failing typecheck.
- **When a revert doesn't turn the gate green, don't assume the revert is
  right and the gate is flaky — re-derive which direction is actually current
  from the source of truth** (here, `schema.ts` itself), not from what an
  uncommitted diff claims to be doing.
- **A migration table's FROM-side is a historical record, not a mirror of the
  current schema.** Renaming it to match a schema change breaks exactly the
  backward compatibility the table exists for.
- Stashed/abandoned WIP with a real fix inside it is worth reviewing before
  discarding, but review it as a diff to evaluate — not a patch to trust and
  apply wholesale; it had its own regressions.
