---
task: settings-cascade-importance
title: "Two bands in the resolver — any origin may declare `!important`, and importance reverses origin order"
state: queued
owner: agent
size: M
discipline: code
design: "ADR-0008 (`docs/decisions/ADR-0008-settings-cascade-and-importance.md`) is authoritative; spec Decision 62 is the summary; `docs/wiki/concepts/Settings Cascade.md` is the reader-facing version. The MDN facts the reversal rests on are `docs/plan/verification-notes.md` §157. The code is `src/config/loader.ts` (`applyObjectLayer` is the merge path), `src/config/schema.ts` (leaf validators, untouched by design) and `src/config/control-surface-*.ts` for how a pinned control renders."
gate: "Reversal is asserted per pair, not in aggregate: `user!` beats `team!` beats `project!` beats `local!`, and EVERY important beats EVERY normal. A file origin's `!important` beats `GOLEM_*` — that one reverses a shipped decision, so it gets its own named test. `\"!important\"` naming a key the file does not set WARNS and does not throw. Provenance reports the origin AND `important: true`. A settings file with no `!important` key resolves byte-identically to today — assert against the existing loader fixtures, unchanged."
depends_on: []
touches: [src/config/loader.ts, src/config/index.ts, src/config/control-surface-settings.ts, src/config/control-surface-types.ts]
created: 2026-09-04
updated: 2026-09-04
---

## Why this is its own task

`team-settings-layer` used to carry the enforcement mechanism, because
enforcement was a team feature (the layer appeared in the ladder twice, keyed off
an `enforced` flag). ADR-0008 made it a property of **every** origin, so the
mechanism is no longer a team concern and no longer wants to land inside a task
about fetching from a portal.

This task builds the cascade. `team-settings-layer` then populates one origin in
it and depends on this landing first.

## The model, in one table

```
              NORMAL  (low → high)          IMPORTANT  (low → high)
    weakest   default                       override!
              user                          env!
              team                          local!
              project                       project!
              local                         team!
              env                           user!
   strongest  override                      default!
```

Every important declaration beats every normal one. Resolution order is the left
column top-to-bottom, then the right column top-to-bottom.

**`env` and `override` contribute normal declarations only** — there is no
syntax for importance in an env var, and inventing one is explicitly out of
scope. Their rows in the important band define the ordering; nothing currently
produces them.

**`team` does not exist as an origin yet.** Add the `LayerName` value and give it
its rank, so `team-settings-layer` has a slot to fill; do not build the fetch.

## Syntax

```json
{
  "compression": { "level": "2" },
  "telemetry": { "enabled": false },
  "!important": ["telemetry.enabled"]
}
```

Top-level, sibling to the sections, an array of dotted `section.key` strings.

**Do not turn this into a value wrapper.** ADR-0008 rejected
`{"$value": …, "$important": true}` specifically so that every zod leaf in
`schema.ts` keeps calling `safeParse` on exactly the shape it parses today. The
merge path in `applyObjectLayer` is the subtlest code in `src/config/` — it
already juggles retirement, migration, shadowed renames and per-key provenance —
and unwrapping values inside it is how that gets broken.

## What to build

1. **Parse `"!important"` per origin.** A set of dotted keys, alongside the
   values that origin declared. A key named there but not set in the same file
   is a **warning** in the existing `warnings[]` channel — the same class as
   `unknown setting "…" ignored` — not a throw.
2. **Resolve in two passes**, not one. Normal declarations cascade as they do
   now; important declarations cascade afterwards in reversed origin order. A
   single pass with a priority number per key also works, but the two-pass shape
   is what the ADR describes and is far easier to read against the table above.
3. **`LayerName` gains `"team"`.** One value. Rank it between `user` and
   `project`.
4. **`ProvenanceEntry` gains `important?: true`.** Set it whenever the winning
   declaration came from the important band.
5. **Rank order lives in one place.** A single ordered array of origins that both
   passes read — one forwards, one reversed. Two hand-maintained lists that must
   stay mirror images is a bug waiting for the next origin.

## What a pinned control must say

The control surface already renders `locked` rows for env-fixed settings and
already carries `ApplyResult.overridden`. Importance makes both common rather
than rare, so:

- A control the cascade has pinned renders **locked**, with a reason that names
  **the origin and the reader's recourse**. "Set by `<team>` as `!important` — a
  repo or a checkout cannot override it; `~/.golem` can, with `!important`" is
  answerable. "Locked" is not.
- Writing at an origin the cascade will overrule must report `overridden`. It
  stops being an edge case a UI may skip.

`ENV_LOCKED` in `control-surface-types.ts` is the existing precedent for the
wording; follow its shape.

## The floor — do not skip this

`proxy.bypass_all` is in the settings schema and writable from a file, and
R8.33's "only the CLI or this panel" rule was written before any remote origin
existed.

Build the deny-list **mechanism** here, compiled in, with `proxy.bypass_all` on
it, applied to any origin marked remote. `team-settings-layer` is what marks an
origin remote, so here it is a mechanism with no origin using it yet — a test
can construct one. A denied key is **dropped with a loud warning**, never
sanitised in silence, and a list the remote could edit would not be a floor.

CLAUDE.md's hard rule governs: **importance is a dial, and no dial value can
disable redaction.**

## Out of scope

- Fetching or caching a team layer (`team-settings-layer`).
- Importance syntax for env vars or headers.
- Per-project team values — the project origin already is that feature.
- Any change to `src/interfaces/`. Nothing here touches a frozen contract.

## The regression that matters most

**An install with no `!important` anywhere must resolve byte-identically to
today.** The existing loader fixtures are the assertion; they should pass
unmodified. If one needs editing to go green, something has changed that this
task did not intend to change.
