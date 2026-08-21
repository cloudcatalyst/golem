---
task: subagent-park
title: A subagent cannot park — it dies at the usage limit while the parent session is protected
state: queued
owner: agent
size: M
design: No memo. The park is `src/hooks/snooze-nudge.ts` (advisory vs enforcing) reached from `src/hooks/pre-tool-use.ts`, with `mcp__golem__snooze` as the one permitted call. Spec Decision 38 (snooze) and Decision 45 (enforcement). `.claude/rules/golem-snooze-hold.md` is the guidance it implements.
gate: Work in flight inside a subagent survives a usage limit, or the spawn that would lose it is refused before it starts. Demonstrated against a real limit, or against an injected one — not argued from the code.
depends_on: []
touches: [src/hooks/pre-tool-use.ts, src/hooks/snooze-nudge.ts, src/proxy/limit-prediction.ts, src/autonomy/classify.ts, docs/wiki]
created: 2026-08-22
updated: 2026-08-22
---

## What happened, 2026-08-22

Three subagents were dispatched on R12 work. Two — R12.2 and `docs-slider-drift`
— **terminated on an API error**: `Agent terminated early due to an API error:
You've hit your session limit`. Their last recorded words were "All green.
Committing." and "Committing on a fresh branch off main."

They survived only by luck: both had already committed. Had either been
mid-edit, the work would have been lost, and **losing in-flight agent work to a
usage limit is the exact motivation recorded for spec Decision 20a**, which the
snooze park exists to answer.

Meanwhile the parent session was protected properly. At ~96% utilization its
next tool call was denied with the enforcing park instruction naming
`mcp__golem__snooze` as the only permitted action. The park works. It just does
not reach a child.

## Why the park does not reach them

The park is a **tool-call gate**: `PreToolUse` denies calls and redirects to
`snooze`. The limit, however, is hit on a **model request** — the child's turn
fails upstream before it ever proposes a tool call, so there is nothing for the
gate to deny and no opportunity for the child to write a note.

So this is a structural gap, not a bug in the gate. Do not "fix" it by making
the gate stricter in the child; the child never gets a turn to be gated.

## The mechanism most likely to work: gate the SPAWN, not the child

The parent's own `PreToolUse` hook sees the spawn as a tool call. So the
buildable move is: **refuse to start a subagent when there is not enough headroom
for it to finish**, and say why. That keeps every rule already in place — the gate
stays a tool-call gate, the decision stays local, and nothing new touches the
request path.

The interesting part is the threshold, and it is not the park threshold. A spawn
at 60% that runs for twenty minutes can still die at 100%; a spawn at 85% that
takes one minute will not. So:

- **Estimate the cost of a spawn** rather than treating it as one call. Golem has
  real material for this: `src/proxy/limit-prediction.ts` (R5.1 snooze P2a,
  observe-only) already predicts against the rate-limit headers, and this session
  offers measurements — the three agents consumed ~171k, ~186k and ~186k
  subagent tokens over 85–94 tool calls each. A spawn is worth roughly an hour of
  ordinary session burn, and pretending otherwise is what lost the two agents.
- **Refuse, with the number in the message.** "Not enough headroom to spawn: 62%
  used, a subagent has historically cost ~15–20% of a window. Park, or do this
  inline." A refusal that does not say what it measured will be worked around.
- **Never silently allow.** Consistent with ADR-0002's fail-closed default: if
  utilization cannot be read (the cold-feed case, which Golem already warns about
  once), the honest answer is to warn on the spawn rather than assume headroom.

## Also worth deciding, and cheaper

Even with a spawn gate, a long-running child can outlive its budget. Two
mitigations that do not need a reverse channel:

1. **Tell children to checkpoint early.** The two survivors survived *because*
   they had committed. A guidance rule that instructs a dispatched agent to commit
   working increments before starting anything long is nearly free and would have
   made this a non-event. Note the tension with "one workstream per PR" — the
   instruction is commit early on your own branch, not merge early.
2. **Have the parent notice.** A child that dies on an API error reports it in its
   task notification. The parent can convert that into a durable task (R5.1)
   naming what the child was doing, so the place is not lost even though the child
   is gone. This is the honest version of "resume": the record survives, the
   process does not.

## Out of scope

Any attempt to inject a turn into a dying subagent, or to make the proxy answer a
child's request with a synthetic instruction — that is Decision 37 territory and
the same reasoning applies. Raising the account's limits. Changing what the park
does in the parent, which works.

## Gate detail

Reproduce first: drive utilization high (or inject a reading — the hook already
takes an injected `snooze.enforce` for tests, so an injected utilization is the
same shape) and show a spawn being refused with its numbers. Then show the
unchanged path: with headroom, a spawn behaves exactly as today. `golem status`
should say when spawns are being gated, the way it already says
`park advisory|enforced`.
