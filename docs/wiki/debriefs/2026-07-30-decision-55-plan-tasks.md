---
title: 2026-07-30 — Decision 55, roadmap work becomes committed Golem tasks
type: debrief
tags: [planning, tasks, roadmap, workflow]
sources: ["docs/golem-spec.md (Decision 55)", "src/tasks/plan-task.ts", "src/cli/plan-index.ts", "docs/plan/tasks/README.md"]
created: 2026-07-30
updated: 2026-07-30
---

# Decision 55 — roadmap work becomes committed Golem tasks

The ask, verbatim: *"can we create Golem tasks, like when we park a conversation? it
would be good to have a means to persist tasks like this and reduce the roadmap to a
live list of links to the tasks. maybe 'tasks' become a document type and go into
docs/plan/tasks. Either way, it should be consistent with Golem's snoozed tasks."*

Plus: compact the shipped prose to one-liners in a separate `SHIPPED.md`.

## The problem it names

`ROADMAP.md` had grown to ~320 lines in which shipped prose outnumbered open work
several times over, and every open item's detail lived in a table cell or a linked
design memo. So handing an item to a fresh agent meant reading the roadmap first —
which is the opposite of what a task is for.

The insight in the ask is the good part: **Golem already had a durable task
primitive**, built for parking a session at a usage limit (R5.1, Decision 38). The
roadmap did not need a new mechanism, it needed the existing one pointed at a second
lifetime.

## What was built

**One task concept, two scopes.** `PlanTaskStore` implements the same `TaskStore` shape
as `FileTaskStore` over a different home and a different encoding:

| scope | location | committed? | encoding |
|---|---|---|---|
| local | `.golem/tasks/<uuid>.json` | no | JSON |
| plan | `docs/plan/tasks/<id>.md` | **yes** | Markdown + frontmatter |

It does **not** extend `FileTaskStore` — the encodings differ, and inheritance would
invite a write through the JSON path into a Markdown file.

**Markdown, because a task has three readers.** A human reviewing a diff, an agent being
handed the work, and the CLI; JSON serves only the third. The load-bearing choice is
that **the body maps onto `Task.prompt`** — that is what makes every existing surface
work unchanged rather than needing plan-specific variants.

**The roadmap is generated.** `golem task index [--summary|--write|--json]` renders the
open-work table between `golem:task-index` markers and splices it in place — the same
idempotent marker-fenced technique Decision 52 uses on `system`. Missing markers
**refuse** rather than appending a second index.

**CLI:** `task list --plan/--local`, `task show` across scopes, `task index`, a new
`task done`, and `task cancel` made scope-aware.

## Three details worth keeping

1. **`blocked` is metadata, not a state.** A blocked task stays `queued`, because it is
   work that exists and will be done, and burying it in a terminal state is how items
   get lost — the roadmap's own "visible, not lost" rule. An *unfinished* `depends_on`
   also blocks; a *dangling* one does not, so a typo cannot park a task forever.
2. **Exact id beats prefix.** Plan ids are short and human (`R8.5`, `21e`), so a
   prefix-only resolver would call `R8.5` ambiguous against `R8.50` and refuse a
   perfectly unambiguous id.
3. **`planTaskSlug` slugifies before `path.basename`**, so a traversal attempt becomes
   an ordinary ugly filename rather than an escape. The test asserts the *property* —
   the resolved path stays inside the directory — rather than a particular output
   string, which is what a first draft of that test got wrong.

## The drift guards are the real deliverable

Generating an index only helps if it is regenerated. `tests/integration/plan-tasks-roadmap.test.ts`
runs against the real `docs/plan/` and fails the suite when:

- the committed index does not match a fresh render (**a stale roadmap is a test
  failure**);
- an open task names neither a gate nor a blocker — this repo's precedent is that the
  gate decides and REGRESSED is an acceptable answer (§89, §100), so a task without one
  cannot fail honestly;
- an open task points at no design and gives no blocker;
- a `depends_on` dangles, or the graph has a cycle;
- an index link points at a missing file;
- an `owner: user` task gives no reason — that is what stops an agent picking up an
  outward or credentialed act.

## The initial task set: 23 documents

Everything previously scattered across the roadmap tables, the R8 memo, the R6 memos,
the loose-ends table, and open `verification-notes.md` findings. **13 ready, 10
blocked.**

Three had no home at all before this, which is the clearest argument that the old
structure was losing work:

- **[R8.13]** §99's cache-verdict defect — shipped and wrong ~98% of the time. It lived
  only in a verification note.
- **hook-precedence** — §91's undocumented PreToolUse precedence between a rewriting
  hook and a denying hook. Recorded as "open" in a note and nowhere else.
- **local-models** — `golem devices` reports the tier *catalog*, not what Ollama has
  pulled. This has now cost three times (the 2026-07-17 judge bug, then a caveat on
  §89, then the same caveat on §100) and had never been written down as work.

Every `owner: user` task states why it is the user's: credentials, hardware, an outward
act, or a decision that is not an implementation.

## Also done

- **`docs/plan/SHIPPED.md`** — one line per landed release/task with a pointer to its
  wiki debrief and spec Decision. The prose is in git history and in
  `docs/wiki/debriefs/`; ~150 lines came out of the roadmap.
- **`BACKLOG.md` compressed the same way** — resolved rows keep a pointer, not a
  summary, so the open section is visible. One row was also *wrong*: the 2026-07-24
  cache-observability idea was still marked `raw` despite having shipped as R8.1.
- **Batch close-out changed** (CLAUDE.md + the `/golem/close-out` skill):
  `golem task done` → `golem task index --write` → a `SHIPPED.md` one-liner → the
  debrief. The `/golem/plan` skill now reads `golem task index --summary` and proposes a
  task *document* rather than a roadmap table row.

## Note on this session

Golem's own snooze enforcement fired mid-batch at ~90% window utilization and denied
every tool but `snooze` — including the `golem task add` the guidance rule asks for
first. Parked with `snooze`, resumed in-place after the reset, and finished. The
mechanism worked as designed; the one rough edge is that step 1 of the
`golem-snooze-hold` rule ("document where you're up to with `golem task add`") is
itself denied by step 2's enforcement, so the documentation had to go in the assistant's
own message instead. Worth reconciling — either exempt `golem task add` or drop that
step from the rule.

Records: spec Decision 55 · concept page [[Plan Tasks]] · `docs/plan/tasks/README.md`
· +53 tests.
