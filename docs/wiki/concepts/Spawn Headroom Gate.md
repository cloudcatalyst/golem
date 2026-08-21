---
title: Spawn Headroom Gate
type: concept
tags: [snooze, usage-limits, subagents, pre-tool-use, hooks, decision-38, decision-45, adr-0002]
sources: [src/hooks/spawn-gate.ts, src/hooks/pre-tool-use.ts, src/hooks/snooze-nudge.ts, src/proxy/limit-prediction.ts, docs/plan/tasks/subagent-park.md, docs/plan/verification-notes.md]
created: 2026-08-22
updated: 2026-08-22
---

# Spawn Headroom Gate

Golem refuses to **start** a subagent when the session (5h) usage window cannot
pay for it to finish. The gate lives in `src/hooks/spawn-gate.ts` and runs from
the shared `PreToolUse` hook, immediately after the [[Usage Limit Park]].

## Why a spawn gate and not a child gate

The park is a **tool-call gate**: `PreToolUse` denies calls and redirects the
agent to `snooze`. **A subagent never reaches it.** The limit is hit on a *model
request*, so the child's turn fails upstream —

```
Agent terminated early due to an API error: You've hit your session limit
```

— before it ever proposes a tool call. There is nothing to deny, and no turn in
which the child could write a note. Observed 2026-08-22: two of three dispatched
agents died exactly this way, one word after "All green. Committing." They
survived only because they had already committed; had either been mid-edit the
work would have been lost, which is the motivation recorded for spec Decision
20a.

Making the gate stricter *inside* the child cannot work — the child never gets a
turn to be gated. The one part of a subagent's lifetime the parent issues as an
ordinary tool call is the **spawn**. Gating there keeps every rule already in
place: the gate stays a tool-call gate, the decision stays local, and nothing new
touches the request path.

## How a spawn is priced

Not as one call. A spawn at 60% that runs twenty minutes can still die at 100%;
a spawn at 85% that takes a minute will not — so a spawn is priced as a *span of
burn*. The default is **measured, not guessed**: the three agents of 2026-08-22
consumed ~171k, ~186k and ~186k subagent tokens over 85–94 tool calls each,
roughly 15–20% of a window apiece.

```
refuse when   utilization + spawn_cost_fraction × (in-flight + 1) > 1
```

**In-flight** counts only spawns recorded *after* the reading was taken.
Utilization already includes what running children have spent, so charging them
again would double-count; what it cannot include is a sibling dispatched since —
the three-at-once fan-out, where every spawn in a batch reads the same pre-batch
number and each one looks affordable alone. Allowed spawns are recorded in
`.golem/state/spawn-gate.json`.

## Never silently allow, never deadlock

If utilization cannot be read (no reading yet, or the header feed has gone cold
— see [[Usage Limit Park]] on staleness), the gate **warns instead of assuming
headroom**, per ADR-0002's fail-closed default. The warning is one-shot per
reading: re-issuing the spawn proceeds. That is deliberate — R9.23 is the
precedent for a hard deny making the only permitted action unreachable, and a
blind gate that bricks spawning would repeat it.

## Ordering against the park

The spawn gate runs **after** the park. At or above the park threshold a spawn is
denied by the park like every other call, and "park now" is the more useful
instruction than "that spawn is too expensive". So the spawn gate bites in the
band *below* the park threshold — which is exactly where the lost agents were
dispatched from.

## Surfaces

| Setting | Default | Effect |
| --- | --- | --- |
| `snooze.spawn_gate` | `true` | Gate spawns on headroom at all (`GOLEM_SNOOZE_SPAWN_GATE`) |
| `snooze.spawn_cost_fraction` | `0.18` | Assumed share of a window per subagent (`GOLEM_SNOOZE_SPAWN_COST_FRACTION`) |

`golem status`'s Limits line reports it alongside the park mode:

```
Limits: 5h window 86% used (resets …) · observed 1m ago · park enforced · spawns REFUSED ~18%/agent
```

`REFUSED` is computed against the live reading, so the line claims the gate is
*biting*, not merely enabled. `ungated` prints when the gate is off — a disabled
safety mechanism is exactly the state whose consequences are otherwise invisible.

## What the gate cannot do, and the guidance that covers it

A long-running child can still outlive its budget after a legitimate spawn. Two
mitigations need no reverse channel, and are seeded as the `subagent-headroom`
[[Guidance Rules|guidance rule]]:

1. **Tell every dispatched agent to commit early** — on its own branch. The
   survivors survived precisely because they had committed. Commit early is not
   merge early; "one workstream per PR" still holds.
2. **When a child dies, capture its place** — a death is reported in the task
   notification, so the parent converts it into a durable task naming what the
   child was doing. The record survives even though the process does not.

Both stay inside Decision 37's boundary: nothing injects a turn into a dying
child, and the proxy never synthesises a reply to a child's request.

Related: [[Usage Limit Park]] · [[Guidance Rules]] · [[Blocked State Read Model]]
