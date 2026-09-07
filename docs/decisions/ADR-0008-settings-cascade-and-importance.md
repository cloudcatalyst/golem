---
title: ADR-0008 — The settings cascade: any origin may declare `!important`, and importance reverses origin order
type: adr
tags: [config, settings, precedence, cascade, important, team, portal, css]
sources:
  [src/config/loader.ts, src/config/schema.ts, src/config/control-surface-types.ts, docs/wiki/concepts/Team Layer.md, docs/wiki/concepts/Configuration Surfaces.md, docs/plan/tasks/team-settings-layer.md, docs/plan/verification-notes.md#157]
created: 2026-09-04
updated: 2026-09-06
---

# ADR-0008 — The settings cascade: any origin may declare `!important`, and importance reverses origin order

**Status: ACCEPTED (2026-09-04, USER DECISION).** Replaces the "team layer
appears twice" mechanism designed in `team-settings-layer` and
[[Team Layer]] — that mechanism is a special case of what this ADR generalises,
and it is retired rather than extended. Amends the shipped precedence decision
that put `GOLEM_*` above every other layer (see §The env reversal). Does not
modify ADR-0004; `proxy.bypass_all` stays exactly as it is, and §The floor is
what keeps this ADR from becoming a way around it.

**Amended by Decision 63 (2026-09-06, USER DECISION):** the offline cache this
ADR describes as `~/.golem/team.json` is keyed by org instead,
`~/.golem/teams/<org_id>.json`. One machine holds projects belonging to
different teams, so one file has one slot for two team layers. Nothing else here
moves; see §What this does NOT change → The offline rule.

## Context

Golem resolves settings as a strict last-writer-wins cascade over six origins
(`src/config/loader.ts:50`):

```
default → user → project → local → env → override
```

Every value is a plain value. There is no way for an origin to say *"this one
matters — do not let a later layer quietly change it"*. Two independent needs
had already run into that:

1. **A team needs policy, not just defaults.** The portal's team layer wants
   both "a sensible company starting point" and "a redaction rule nobody
   overrides". The design met that by putting the team layer in the ladder
   **twice** — once below the file layers as defaults, once above them for keys
   an admin flagged `enforced` — with `enforced` as the whole contract.
2. **A project needs invariants.** A repo whose maintainers require, say,
   compression off has no way to encode that. `.golem/settings.json` is just
   one more overridable layer, and `settings.local.json` silently beats it.

The team-twice mechanism solves (1) and nothing else. It costs two `LayerName`
values for one source, makes provenance answer "which of the two team
positions" rather than "the team", and it does not generalise: a project cannot
use it, and neither can a user.

The user's framing, which this ADR adopts:

> a foundation of user `~/.golem` settings, remote team settings and local
> project `.golem` settings … each previous level of config is able to provide
> settings which are `!important`, like CSS

That is one mechanism where there were two, and it is a mechanism every origin
gets rather than a flag one remote source gets.

## The origins

Seven, most foundational first. `team` is new; the rest are today's ladder with
`team` inserted:

| # | origin | store | who owns it |
|---|---|---|---|
| 1 | `default` | compiled-in | Golem |
| 2 | `user` | `~/.golem/settings.json` | the person at the keyboard |
| 3 | `team` | portal, cached to `~/.golem/teams/<org_id>.json` | the org's admins |
| 4 | `project` | `<project>/.golem/settings.json` (committed) | the repo |
| 5 | `local` | `<project>/.golem/settings.local.json` (gitignored) | this checkout |
| 6 | `env` | `GOLEM_*` | the invoking shell |
| 7 | `override` | per-request headers | the caller |

**A team is shared across many projects, so the team origin is
project-agnostic.** That is why `project` sits above it in the normal band: a
repo specialising a company default is the expected case, not a violation. A
team that must hold a value across every project marks it `!important`; a team
that wants to permit divergence simply does not. Per-project team overrides are
deliberately **out of scope** — the project origin already is that feature, and
storing per-project team values would put the same answer in two places.

## The two bands

Every declaration is either normal or important. Normal declarations cascade in
origin order; important declarations cascade in **reversed** origin order.

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

Every important declaration beats every normal one. Resolution order, lowest to
highest precedence, is the left column top-to-bottom followed by the right
column top-to-bottom.

This is the CSS cascade, and the mapping is exact rather than decorative
(verified against MDN's origin table AND the `@layer` important-order
rule, verification-notes §157):

| CSS origin | Golem origin |
|---|---|
| user-agent stylesheet | `default` |
| **user** stylesheet | **`user` — `~/.golem`** |
| author, org-wide cascade layer | `team` |
| author, repo cascade layer | `project` |
| author, checkout cascade layer | `local` |

CSS reverses origin order for important declarations, and it reverses cascade
**layer** order within an origin too. So `team!` beating `project!` and
`local!`, while `user!` beats all three, is not an invention here — it is what
the analogy actually says when the layers are mapped honestly.

### Why reversal is the right half of the analogy

Reversal is the part that makes this worth doing rather than a second way to
spell "highest wins":

- **It gives a team real enforcement.** `team!` cannot be overridden by a
  committed repo file or a developer's gitignored one. That is the whole of what
  `enforced` bought, with none of the double-position machinery.
- **It leaves the person at the keyboard a durable escape hatch.** `user!` is
  the strongest origin any human can write, so a developer can always pin a
  value in `~/.golem` and know nothing remote will move it. Golem's existing
  posture already insisted such a hatch exist; reversal is what makes it a
  reviewable file instead of an ephemeral env var.
- **It gives the floor a home.** `default!` is the strongest band there is, so a
  value Golem ships as important cannot be weakened by any origin at all. See
  §The floor.

The honest cost is stated in §Consequences accepted: **`enforced` stops meaning
"unbreakable"**. A team can bind every repo and every checkout, and cannot bind
the individual. For a local-first tool that is the correct place to draw it, but
it is a change of meaning and the portal's wording has to follow.

## The env reversal

**`GOLEM_*` is now an origin inside the cascade, not an override above it
(USER DECISION).** The shipped position, in `team-settings-layer`'s gate and in
[[Team Layer]], was the opposite, in those words:

> `GOLEM_*` still wins over an enforced key. It already wins over every file
> layer, and carving out an exception would mean a setting that cannot be worked
> around on a machine that is on fire. Do not "fix" this.

That is superseded. `env` becomes origin 6, so **an important declaration from
any file origin now beats `GOLEM_*`.** The consequence, stated plainly rather
than softened: *setting an env var no longer defeats team policy.*

The escape hatch does survive — it moves. `user!` in `~/.golem` beats `team!`,
so a developer who must deviate still can, durably and visibly, rather than by
re-exporting a variable in every shell. The trade is ephemeral-and-invisible for
durable-and-reviewable. It was raised as a concern before being chosen, and it
was chosen with the consequence on the table.

**Env and headers contribute normal declarations only.** There is no syntax for
importance in an env var, and inventing one (`GOLEM_IMPORTANT=…`) would be a
second grammar for a rare case. So the important band is `default!`, `user!`,
`team!`, `project!`, `local!` — five entries, not seven. The `override!` and
`env!` rows in the table above exist to define the ordering, not because
anything can currently produce them.

## The floor: what a remote origin may never set

`proxy.bypass_all` is in the settings schema (`src/config/schema.ts:116`) and is
therefore writable from a settings file today. Its own UI text says *"a tool
call cannot set it (R8.33), only the CLI or this panel"* — but a **remote**
origin is a path R8.33 never contemplated, because no remote origin existed.

Without an explicit floor, this ADR would create a remote redaction-disable: an
admin, or anyone who compromised the portal, could ship
`proxy.bypass_all: true !important` and every machine in the org would forward
unredacted traffic, with `team!` beating every local file.

So, as invariants and not as configuration:

1. **The `team` origin has a deny-list of keys it may never contribute, at any
   importance.** `proxy.bypass_all` is on it. A team payload naming a
   denied key is **dropped with a loud local warning**, never applied — the
   payload is refused, not sanitised silently.
2. **The deny-list is compiled in, not fetched.** A list the remote can edit is
   not a floor.
3. **`default!` is the mechanism for any future non-negotiable value.** It
   outranks every other origin, so a hard guarantee expressed there cannot be
   argued with by any file or any remote.

CLAUDE.md's hard rule is unchanged and this ADR is subordinate to it: *"Redaction
must never be weakened or reordered. `proxy.bypass_all` is the single exception
(full bypass, never default, CLI-only, surfaced loudly — ADR-0004). No dial value
can disable it."* Importance is a dial. It gets no exception.

## Syntax

JSON has no `!important`, so it is a sibling declaration rather than a value
wrapper:

```json
{
  "compression": { "level": "2" },
  "telemetry": { "enabled": false },
  "!important": ["telemetry.enabled"]
}
```

A top-level `"!important"` array of dotted keys. Chosen over the alternatives
because:

- **Value shapes are untouched**, so every zod leaf validator in `schema.ts`
  keeps parsing exactly what it parses now. A wrapper object
  (`{"$value": 2, "$important": true}`) would have to be unwrapped before every
  `safeParse`, in a file whose merge path is already the subtlest code in
  `src/config/`.
- **`"!important"` cannot collide with a section name** — sections are lowercase
  identifiers.
- **It maps 1:1 to the portal's existing per-key `enforced` boolean**, so the
  team wire format needs no change, only a restatement of what the flag means.
- **It diffs well.** Marking a key important is a one-line change in review,
  next to the value it applies to.

Naming a key in `!important` that the file does not set is a **warning, not an
error** — same class as the existing `unknown setting "…" ignored`. Importance
without a value is meaningless, not dangerous.

## Provenance and the UI

Provenance already answers "why is this value what it is" per dotted key. It now
has to answer one more question, so:

- `LayerName` gains **`"team"`** — one value, not two. The team-twice positions
  are gone, which is a net simplification of the type this ADR touches.
- `ProvenanceEntry` gains **`important?: true`**.
- Provenance for a team value names **the team**, not just the origin. That
  requirement predates this ADR and survives it.
- A control the resolved cascade has pinned renders **locked**, as env-fixed
  settings already do — but the reason string must say which origin and what the
  reader's recourse is. "Set by <team> as `!important` — a repo or a checkout
  cannot override it; `~/.golem` can, with `!important`" is answerable. "Locked"
  is not.
- Writing at an origin the cascade will overrule must report it. `ApplyResult`
  already carries `overridden` for exactly this; importance makes it common
  rather than rare, so it stops being an edge case the UI may skip.

## Portal consequences

The wire format is unchanged; three meanings change.

1. **`enforced: true` now means "`!important` at the team origin".** It binds
   every repo and every checkout. It does **not** bind a developer's `~/.golem`
   important declaration. Any portal copy that says "locked" or "cannot be
   overridden" is now wrong and must say what it actually does.
2. **The team origin sits above `user`, not below it.** A non-enforced team key
   is no longer "below anything a person writes" — it overrides a personal
   normal preference. The reader's recourse is `!important`, which is explicit
   and shows up in provenance. This is the CSS relationship (author normal beats
   user normal) and it is what makes importance the *single* enforcement
   mechanism rather than one of two.
3. **The portal must not offer the denied keys at all.** The client drops them,
   but a form that accepts `proxy.bypass_all` and an admin who believes they
   have set it is the failure this whole design keeps trying to avoid. Refuse at
   write time, with the reason, the way `looksSecret` already refuses
   credentials.

## What this does NOT change

- **Redaction.** Unconditional, unreordered, no dial. See §The floor.
- **ADR-0004.** `proxy.bypass_all` keeps its shape, its loudness and its
  CLI-only write path.
- **The offline rule.** The team layer still caches; stale policy still beats
  absent policy; `golem status` still reports its age. Decision 63 later keyed
  the cache per org, `~/.golem/teams/<org_id>.json`, and made the age report
  per team; the rule itself is unchanged.
- **The failure rule.** A team link is an enhancement to a local-first tool.
  Nothing about it may stop the proxy from starting — an unreachable portal
  falls back to the cache, then to local config, loudly.
- **Retired and migrated keys.** `RETIRED_SETTINGS` still raises and
  `SETTING_MIGRATIONS` still renames, before importance is considered.
- **Frozen interfaces.** Nothing in `src/interfaces/` moves. `LayerName`,
  `ProvenanceEntry` and the control surface are not frozen contracts.

## Consequences accepted

1. **`enforced` is no longer absolute.** A determined developer can always pin
   past team policy with `user!`. Teams that need a guarantee against the
   individual need a control Golem does not have and this ADR does not add;
   what they get is a guarantee against every repo and checkout, plus
   provenance that makes a deviation visible rather than silent.
2. **`GOLEM_*` is no longer the last word.** Documented above as a deliberate
   reversal, with the hatch relocated to `user!`.
3. **Two bands are harder to explain than one ladder.** The mitigation is that
   the model is one people already know, and that provenance is expected to
   state the band, not just the origin.
4. **`local!` is nearly pointless.** Under reversal it is the weakest file
   importance, so it beats only normal declarations. It is permitted for
   uniformity rather than because it is useful.
5. **This is a behaviour change to a shipped resolver.** Existing installs
   resolve identically — nothing declares importance until someone writes it,
   and `env` only changes rank relative to importance, which did not previously
   exist. The one live change is the team origin's position, and no client ships
   a team layer yet.
