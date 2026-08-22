---
title: subagent-park — the park is a tool-call gate, so gate the spawn
type: debrief
tags: [subagent-park, snooze, usage-limits, subagents, pre-tool-use, hooks, decision-38, decision-45, adr-0002, r12]
sources: [docs/plan/tasks/subagent-park.md, docs/plan/verification-notes.md, src/hooks/spawn-gate.ts, src/hooks/pre-tool-use.ts, src/hooks/snooze-nudge.ts, src/hooks/guidance.ts, src/config/schema.ts, src/cli/status-render.ts]
created: 2026-08-22
updated: 2026-08-22
---

# subagent-park — the park is a tool-call gate, so gate the spawn

The task filed the same day two dispatched agents died at the usage limit while
the parent session was protected correctly. See [[Spawn Headroom Gate]] for the
mechanism and [[Usage Limit Park]] for what it sits behind.

## Outcome

A spawn-headroom gate in `src/hooks/spawn-gate.ts`, wired into the shared
`PreToolUse` hook after the park block. It refuses to start a subagent when
`utilization + spawn_cost_fraction × (in-flight + 1) > 1`, states every number it
measured in the refusal, and warns rather than assuming headroom when it cannot
measure at all. Two settings (`snooze.spawn_gate`, `snooze.spawn_cost_fraction`),
a seeded `subagent-headroom` guidance rule, and a `golem status` Limits line that
now says `spawns allowed | REFUSED | ungated | warn-once`.

Demonstrated against an injected utilization through the real hook, not argued
from the code: 21 unit tests on the decision function, 8 more driving
`runPreToolUseHook`.

## Key lessons

**1. The gap was structural, and naming the mechanism is what found the fix.**
The park is a *tool-call* gate; the limit is hit on a *model request*. A child's
turn fails upstream before it proposes a call, so there is nothing to deny and no
turn in which it could write a note. Once that is stated plainly, the tempting
fix — make the gate stricter in the child — is visibly impossible, and the only
reachable surface (the spawn, which the *parent* issues as an ordinary tool call)
falls out. The task brief got this right before any code was written, and the
implementation did not have to rediscover it.

**2. Price the thing being gated, not the call that starts it.** A spawn is not
one call, it is a span of burn: 60% with a twenty-minute agent still dies, 85%
with a one-minute agent does not. Treating a spawn as a call is what lost the two
agents. The default (18%) is a measurement from the incident itself — ~171k–186k
subagent tokens over 85–94 tool calls each — not a round number chosen to look
cautious.

**3. The in-flight term is where the fan-out was actually lost.** Utilization
already contains what *running* children have spent, so charging them again would
double-count. What it cannot contain is a sibling dispatched **since the reading
was taken** — three spawns in one turn all read the same pre-batch number and each
looks affordable alone. Recording allowed spawns and charging any that postdate
`observedAtIso` is a handful of lines and is the difference between a gate that
catches the observed failure and one that catches only a hypothetical.

**4. Fail-closed had to be split from fail-hard.** "Never silently allow" and
"never deadlock" pull in opposite directions when the gate is blind. R9.23 is the
standing precedent for the second failure — a deny that made the only permitted
action unreachable, twice. The resolution: a blind spawn warns **once per
reading**, then a re-issue proceeds. The agent cannot drift past the warning
unaware, and cannot be bricked by it either.

**5. Ordering the new gate after the old one was a message-quality decision.**
Above the park threshold a spawn is denied anyway; putting the spawn gate first
would replace "park now, here is the one call that saves your place" with "that
spawn is too expensive", which is true and useless. The consequence is that the
spawn gate only bites *below* the park threshold — which is precisely the band
the lost agents were dispatched from, so the narrowing costs nothing.

**6. `status` reports whether the gate is BITING, not whether it is enabled.**
`spawn_blocked` is recomputed against the live reading. A line that only echoed
the setting would read as reassurance while a spawn was about to be refused, or
while the gate sat disabled. `ungated` prints for the same reason: a disabled
safety mechanism is the state whose consequences are otherwise invisible.

**7. What could not be built was written down as guidance instead of skipped.** A
long-running child can outlive its budget after a legitimate spawn, and no
tool-call gate reaches that. The two mitigations that need no reverse channel —
commit working increments early on your own branch, and convert a dead child's
task notification into a durable task — are now seeded as the `subagent-headroom`
rule. Both stay inside Decision 37's boundary: nothing injects a turn into a
dying child and the proxy synthesises nothing.

## What deliberately did not happen

No numbered spec Decision. Decisions 55–59 are all user calls; this is an
agent-owned task implementing existing Decisions 38/45 within ADR-0002, so
elevating it to the Decisions Log is the user's to make. The reasoning is in
verification-notes §137 either way.

No attempt to reach into a dying subagent, and no change to what the park does in
the parent — both explicitly out of scope in the brief, and both still out of
scope in the result.

Related: [[Spawn Headroom Gate]] · [[Usage Limit Park]] · [[Guidance Rules]]
