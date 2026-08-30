# Plan tasks

One document per unit of open work, so a task can be handed **whole** to a fresh
agent or a separate conversation without anybody first reading the roadmap.

These are Golem tasks — the same `Task` concept and the same `golem task` CLI that
parks a session at a usage limit (R5.1, spec Decision 38). They differ only in
scope:

| scope | location | committed? | encoding | holds |
|---|---|---|---|---|
| **local** | `.golem/tasks/<uuid>.json` | no | JSON | parked sessions, snooze holds, resumes |
| **plan** | `docs/plan/tasks/<id>.md` | **yes** | Markdown + frontmatter | roadmap work |

## Working with them

```
golem task list                # both scopes, plan first
golem task list --plan         # roadmap only
golem task show R8.5           # the full brief
golem task index --summary     # one-screen ready/blocked view
golem task index --write       # regenerate the ROADMAP.md index in place
golem task done R8.5 --note …  # close it; re-run `index --write`
```

`ROADMAP.md` holds only a **generated** index of links to these files, between the
`golem:task-index` markers. Edit the task document, never that table.

## Frontmatter

| key | meaning |
|---|---|
| `task` | stable id, also the filename (`R8.5`, `21e`). Never reused. |
| `title` | one-line goal, as it appears in the index. |
| `state` | `queued` · `running` · `blocked` · `paused` · `done` · `failed` · `cancelled`. |
| `owner` | `agent` (an agent can do it) or `user` (an outward or credentialed act an agent must not take). |
| `size` | `S` · `M` · `L` — rough effort, for picking work, not for scheduling. |
| `discipline` | optional, free-form — which *kind* of worker should staff this (`code`, `review`, `write`, whatever a project decides). The routing axis, distinct from `owner` (the permission axis: may an agent do this at all). **Inert on an unrecognised value, and inert when absent**: no validation, no warning, no staffing lookup — a task naming a discipline nobody staffs behaves exactly as one naming none. That is deliberate (USER, 2026-08-30), not a gap to "fix" into a closed set; staffing becomes visible on demand via `golem personas` (R14.1), not by a warning here. |
| `design` | where the design already lives, so the brief does not restate it. |
| `gate` | the one-line definition of done / what decides it. |
| `blocked` | why it cannot start *now*, when that is a fact about the world (no hardware, no keys, needs a decision). Keeps it visible rather than lost. |
| `depends_on` | task ids that must land first. |
| `touches` | directories the work is expected to reach — a starting map, not a contract. |

## Writing a good one

A brief is read by someone with **no context**. So:

- **Say what the work is, then what it must not become.** An "Out of scope" section
  saves more time than any amount of goal prose.
- **Point at the design, don't paraphrase it.** The memo, spec Decision, or
  `verification-notes.md §` is authoritative; a summary here goes stale silently.
- **Name the gate.** This repo's precedent is that the harness decides and
  REGRESSED is an acceptable answer (§89, §100). A task without a gate is a task
  that cannot fail honestly.
- **Carry the standing verification bar** rather than restating it: `npx tsc
  --noEmit`, `npm run lint`, `npm run format:check`, `npx vitest run`, plus
  `golem wiki check` if a wiki page changed, and the batch close-out in `CLAUDE.md`.
