---
title: Usage Limit Park
type: concept
tags: [snooze, usage-limits, pre-tool-use, hooks, decision-38, decision-45, adr-0002]
sources: [src/hooks/snooze-nudge.ts, src/hooks/pre-tool-use.ts, src/proxy/limit-prediction.ts, src/cli/status-render.ts, docs/plan/proposals/golem-snooze.md, docs/plan/tasks/snooze-taskadd.md]
created: 2026-08-22
updated: 2026-08-22
---

# Usage Limit Park

As the session (5h) usage window fills, Golem stops the agent working and
redirects it to **park**: one `snooze` call that files a durable note and waits
for the reset, instead of burning the last of the window and losing its place.
Spec Decisions 38 (snooze) and 45 (enforcement by default).

## The parts

**The reading.** The proxy is the only component that sees Anthropic's
per-response `anthropic-ratelimit-unified-*` headers, so it persists a
`LimitPrediction` — 5h and 7d utilization plus reset times — to
`.golem/state/limit-state.json` (`src/proxy/limit-prediction.ts`). Observe-only:
it never alters the forwarded response.

**The decision.** `decideSnoozeNudge` (`src/hooks/snooze-nudge.ts`) turns that
reading into `park`, `stale` or `none`, at a default threshold of **90%**.

**The gate.** The shared `PreToolUse` hook denies the pending tool call and
returns the park instruction as the deny reason.

## Advisory vs enforcing

`snooze.enforce` (default **true**, env `GOLEM_SNOOZE_ENFORCE`):

- **Enforcing** — every tool call outside `PARK_EXEMPT_TOOLS` is denied until the
  agent parks or the window resets. The block must persist, so no one-shot marker
  is written.
- **Advisory** — a single redirect per reset window, which the agent can work
  past.

An honest limit: a `PreToolUse` deny cannot stop the model spending tokens
*reacting* to it. Enforcement funnels the model to `snooze` fast; it is not a
hard token freeze.

## Park must stay reachable

`PARK_EXEMPT_TOOLS` is `mcp__golem__snooze`, `ToolSearch` and
`mcp__golem__expand`. The last two were added after the deny deadlocked live
twice (2026-08-10, 2026-08-13): `snooze` is a **deferred** tool, so calling it
requires loading its schema via `ToolSearch`, and `expand` is the way back from a
CCR reference. Denying either makes the sole permitted tool uncallable. None of
the three spends meaningful budget, which is what makes exempting them safe.

The same reasoning fixed task `snooze-taskadd`: the guidance rule's first step was
`golem task add`, which runs through `Bash` and is therefore denied by its own
second step. Rather than exempt it, `snooze` gained a **`note` parameter** that
files the durable task itself, before the wait — the ordering problem became
structurally impossible instead of exempted. So the park is **one call**:

```
snooze(until="<reset ISO>", note="<where you're up to + next steps>")
```

## When the feed goes cold

The park decision is only as good as the reading, and the reading only refreshes
when an upstream response carries the headers. If the active account or upstream
stops emitting them — an API-key upstream after an account switch, say — the
state freezes. The old logic then failed *silently*: a stale low reading simply
returned "no nudge", so the parking net vanished exactly when it mattered.

`decideSnoozeNudge` now checks staleness **before** park (a park decision is only
trustworthy on a fresh reading) and emits `stale` after 30 minutes: warn once so
the blindness is visible. A stale reading never hard-blocks — a deny on bad data
is worse than the blindness it would be acting on.

## What it does not cover

A **subagent** never reaches this gate at all: it dies on a model request, before
it can propose a tool call to deny. That gap is answered one level up, at the
spawn — see [[Spawn Headroom Gate]].

## Visibility

```
Limits: 5h window 42% used (resets …) · observed 2m ago · park enforced · spawns allowed ~18%/agent
Limits: STALE (last reading 240m ago, 5h 17%) — auto-park blind; … · park enforced · spawns warn-once
```

Related: [[Spawn Headroom Gate]] · [[Guidance Rules]] · [[Plan Tasks]]
