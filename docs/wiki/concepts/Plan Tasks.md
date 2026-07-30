---
title: Plan Tasks
type: concept
tags: [planning, tasks, roadmap, workflow]
sources: ["src/tasks/plan-task.ts", "src/cli/plan-index.ts", "docs/plan/tasks/README.md", "docs/golem-spec.md (Decision 55)"]
created: 2026-07-30
updated: 2026-07-30
---

# Plan Tasks

Roadmap work as **committed task documents** — one file per unit of open work, under
`docs/plan/tasks/<id>.md`. Spec Decision 55 (2026-07-30, USER decision).

The point is dispatchability: a task should be handable **whole** to a fresh agent or a
separate conversation, without that agent first reading the roadmap to work out what it
is being asked.

## One task concept, two scopes

R5.1 gave Golem durable tasks, but only one *home*. Decision 55 added a second, sharing
the same `Task` shape, the same `TaskStore` seam, and the same `golem task` CLI:

| scope | location | committed? | encoding | holds |
|---|---|---|---|---|
| **local** | `.golem/tasks/<uuid>.json` | no | JSON | parked sessions, snooze holds, capacity-gated resumes |
| **plan** | `docs/plan/tasks/<id>.md` | **yes** | Markdown + frontmatter | roadmap work |

Local is right for what created it — a session parked at a usage limit is a fact about
*this* machine that nobody else should inherit. Roadmap items are the same concept with
the opposite lifetime: they outlive a machine and want review in a PR.

**Not two systems.** `golem task list` shows both with a scope column, `golem task show
R8.5` prints the brief, and every mutation writes back to the store the task came from —
`findScopedTask` carries the scope precisely so a plan task cannot be written through the
JSON path.

## Why Markdown, not JSON

A plan task has three readers: a human reviewing a diff, an agent being handed the work,
and the CLI. JSON serves only the third.

So the document is `---`-delimited frontmatter (the machine fields) plus a body — and
**the body maps onto `Task.prompt`**. That one decision is what lets the existing
surfaces work unchanged instead of needing plan-specific variants: `golem task show`
prints the brief, and `golem task resume` can build a headless command from it.

Frontmatter keys: `task` (stable human id, also the filename), `title`, `state`,
`owner` (`agent`|`user`), `size` (`S`|`M`|`L`), `design`, `gate`, `blocked`,
`depends_on`, `touches`. See `docs/plan/tasks/README.md` for the full table and the
house style.

The parser is hand-rolled in the style of `src/wiki/frontmatter.ts` — a small fixed key
set does not justify a YAML dependency ([[Managed Tools]]'s tier ladder). `planTaskSlug`
slugifies **before** `path.basename`, so no id can escape the tasks directory.

## The roadmap is generated

`golem task index` renders the open-work table between
`<!-- golem:task-index:begin/end -->` markers; `--write` splices it into
`docs/plan/ROADMAP.md` in place. Same marker-fenced, idempotent technique the brevity
directive uses on `system` ([[Compression]], Decision 52), and for the same reason: a
replaceable region beats a best-effort diff. Missing markers **refuse** rather than
appending a second index.

```
golem task index --summary     # one screen: ready / blocked
golem task index --write       # regenerate the ROADMAP table
golem task show R8.5           # the full brief
golem task list --plan         # roadmap only
golem task done R8.5 --note …  # close it, then regenerate
```

### `blocked` is metadata, not a state

A blocked task stays `queued`. It is work that exists and will be done, and burying it
in a terminal state is how items get lost — the roadmap's own "visible, not lost" rule
for its loose ends. An **unfinished** `depends_on` also counts as blocked; a **dangling**
one does not, so a typo cannot park a task forever.

## Drift guards

Generating an index only helps if it is regenerated, so
`tests/integration/plan-tasks-roadmap.test.ts` runs against the real `docs/plan/`:

- the committed index must match a fresh render — **a stale roadmap fails the suite**;
- every open task names a **gate or a blocker** (this repo's precedent is that the gate
  decides and REGRESSED is an acceptable answer — see [[Tool Search]]);
- every open task points at a **design** or gives a blocker;
- no duplicate ids, no dangling `depends_on`, no dependency cycles;
- every index link resolves to a real file;
- an `owner: user` task must explain itself, so an agent does not pick up an outward or
  credentialed act.

## Writing a good brief

A brief is read by someone with no context.

- **Say what the work is, then what it must not become.** An "Out of scope" section
  saves more time than any amount of goal prose.
- **Point at the design, don't paraphrase it.** The memo, spec Decision, or
  `verification-notes.md §` is authoritative; a summary here goes stale silently.
- **Name the gate.** A task without one cannot fail honestly.
- **Carry the standing verification bar by reference**, not by restating it.

Related: [[Architecture]] · [[Compression]] · [[Managed Tools]] · [[Context Ledger]] ·
[[Wiki-First Knowledge]] · [[Dogfooding Golem]]
