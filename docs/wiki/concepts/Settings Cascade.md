---
title: Settings Cascade
type: concept
tags: [config, settings, precedence, cascade, important, team, css, provenance]
sources: [docs/decisions/ADR-0008-settings-cascade-and-importance.md, docs/golem-spec.md, src/config/loader.ts, docs/plan/verification-notes.md#154]
created: 2026-09-04
updated: 2026-09-04
---

# Settings Cascade

How Golem decides which of several answers to a setting wins. Seven origins, two
bands, and one rule that surprises people: **importance runs backwards.**

Settled by ADR-0008 / spec Decision 62 (2026-09-04). It replaces the "team layer
appears twice" mechanism [[Team Layer]] was designed around — that was a special
case, and this generalises it so a project and a user get the same power a team
had.

Related pages: [[Team Layer]] · [[Configuration Surfaces]] · [[Redaction Stage]] ·
[[Compression Levels]] · [[Architecture]].

---

## The origins

Most foundational first. Only `team` is new; the rest is the shipped ladder with
`team` inserted.

| # | origin | store | owned by |
|---|---|---|---|
| 1 | `default` | compiled-in | Golem |
| 2 | `user` | `~/.golem/settings.json` | the person at the keyboard |
| 3 | `team` | portal, cached to `~/.golem/team.json` | the org's admins |
| 4 | `project` | `<project>/.golem/settings.json` (committed) | the repo |
| 5 | `local` | `<project>/.golem/settings.local.json` (gitignored) | this checkout |
| 6 | `env` | `GOLEM_*` | the invoking shell |
| 7 | `override` | per-request headers | the caller |

**Why `project` sits above `team`:** a team is shared by many projects, so the
team origin is project-agnostic. A repo specialising a company default is the
expected case, not a violation. A team that needs a value to hold everywhere
marks it important; one that permits divergence does not. Per-project team
values are deliberately not a feature — the project origin already is that
feature, and the same answer in two places is how they drift.

## The two bands

Normal declarations cascade in origin order. Important declarations cascade in
**reversed** origin order. Every important beats every normal.

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

In practice the important band has five entries, not seven: **`env` and headers
contribute normal declarations only**, because there is no syntax for importance
in an env var and a second grammar for a rare case is not worth having.

## Why backwards

Because it is CSS, and the analogy is exact rather than decorative. MDN's origin
table reverses importance across origins *and* across cascade layers within an
origin (verification-notes §154):

| CSS origin | Golem origin |
|---|---|
| user-agent stylesheet | `default` |
| **user** stylesheet | **`user` — `~/.golem`** |
| author, org-wide layer | `team` |
| author, repo layer | `project` |
| author, checkout layer | `local` |

Read that with the reversal and three useful properties fall out at once:

- **A team gets real enforcement.** `team!` beats a committed repo file and a
  gitignored local one. That is the whole of what the retired `enforced` flag
  bought, without a second position in the ladder.
- **The machine's owner keeps a durable escape hatch.** `user!` is the strongest
  origin any human writes. CSS's reversal exists to protect the reader from the
  site author; the same shape protects a developer from a remote admin.
- **The floor gets a home.** `default!` outranks everything, so a value Golem
  ships as important cannot be argued with by any origin.

Had the reversal gone the other way, "important" would have been a second
spelling of "highest layer wins", `team!` would lose to `settings.local.json`,
and the mechanism would be useless for policy while looking like it worked.

## Syntax

A sibling declaration, not a value wrapper — so every zod leaf validator keeps
parsing exactly what it parses now:

```json
{
  "compression": { "level": "2" },
  "telemetry": { "enabled": false },
  "!important": ["telemetry.enabled"]
}
```

`"!important"` cannot collide with a section name (sections are lowercase
identifiers), it diffs well in review, and it maps 1:1 to the portal's existing
per-key `enforced` boolean — so the team wire format needed **no change**.
Naming a key the file does not set is a warning, not an error.

## The floor: what a remote origin may never set

The one place this design could have gone badly. `proxy.bypass_all` lives in the
settings schema and is writable from a file, and its "only the CLI or this
panel" rule (R8.33) was written before any *remote* origin existed. Left alone,
`team!` would have put a remote redaction-disable beyond the reach of every
local file.

So, as invariants rather than configuration:

1. The `team` origin has a **compiled-in deny-list** of keys it may never
   contribute at any importance. `proxy.bypass_all` is on it.
2. A payload naming a denied key is **dropped with a loud local warning** —
   refused, never sanitised in silence.
3. A list the remote could edit would not be a floor, which is why it is
   compiled in.

Redaction itself is not a setting and has no dial ([[Redaction Stage]]).
**Importance is a dial, and no dial value can disable redaction.**

## What `enforced` now means

"`!important` at the team origin." It binds every repo and every checkout; it
does **not** bind a developer's `~/.golem` important declaration.

So `enforced` stops meaning *unbreakable*, and any portal wording that says
"locked" or "cannot be overridden" is now wrong. That cost was accepted
deliberately: for a local-first tool, a guarantee against every repo plus
provenance that makes a deviation visible is the right line — a guarantee
against the individual is not something Golem offers.

## `GOLEM_*` is no longer the last word

The shipped position was the opposite, in those words: *"`GOLEM_*` still wins
over an enforced key … Do not 'fix' this."* Decision 62 reverses it. `env` is
origin 6 inside the cascade, so any file origin's important declaration now
beats it.

The escape hatch did not disappear — it **moved to `user!`**, which is durable
and reviewable where an env var was ephemeral and invisible. Setting an env var
no longer defeats team policy; pinning the key in `~/.golem` does.

## Provenance has to answer more

Precedence was never the gap in `src/config/loader.ts` — presentation was
([[Configuration Surfaces]]). Importance adds one question to it:

- `LayerName` gains **`"team"`** — one value, where the retired design needed
  two positions for one source.
- `ProvenanceEntry` gains `important?: true`.
- A team value's provenance names **the team**, not just the origin.
- A pinned control renders **locked** the way env-fixed settings already do, but
  the reason must name the origin *and* the recourse. "Set by `<team>` as
  `!important` — a repo or a checkout cannot override it; `~/.golem` can, with
  `!important`" is answerable; "locked" is not.
- `ApplyResult.overridden` stops being an edge case a UI may skip: writing at an
  origin the cascade will overrule is now common rather than rare.

## What did not change

Redaction, ADR-0004 and `proxy.bypass_all`'s shape and loudness; the
`~/.golem/team.json` offline cache and its age report; the rule that nothing
about a team link may stop the proxy starting; retirement and migration handling
(both run before importance is considered); and every frozen `src/interfaces/`
contract.

**Existing installs resolve identically.** Nothing declares importance until
someone writes it, and no client ships a team layer yet.
