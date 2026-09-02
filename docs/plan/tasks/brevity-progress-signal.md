---
task: brevity-progress-signal
title: "Silence is not brevity — carve one progress line back out of the no-narration ban"
state: done
owner: agent
size: S
design: USER report 2026-09-02 ("Claude isn't giving me feedback that it is working on things"), diagnosed to `brevity.level = "full"` in `.golem/settings.local.json`. Decision 52 is the stage; this amends its shared safety tail, not a profile.
gate: "Every active level's directive carries a clause permitting ONE short progress line before a tool call, and forbidding it from becoming preamble; the clause lives in the shared tail so it cannot be dropped from one level or drift between three; `brevityEffectNote` says so when a level is set; the wiki documents all four levels and what no level may do."
depends_on: []
touches: [src/pipeline/brevity.ts, src/cli/dials.ts, tests/unit/pipeline/brevity.test.ts, docs/wiki/concepts/Compression Levels.md]
created: 2026-09-02
updated: 2026-09-02
---

## What was wrong

All three active brevity profiles ban self-narration outright:

- `lite` — "Drop filler, hedging, preamble, self-narration…"
- `full` — "No preamble, no self-narration, no recap of what you just did…"
- `ultra` — "No preamble, no narration, no recap, no closing."

That is correct for prose and wrong for a long agentic turn. An agent that runs
six tool calls and then speaks produces a window of pure tool output where the
user cannot tell whether anything is happening — reported exactly that way.

It also put the directive in direct contradiction with this repo's own
`golem-respond-every-turn` rule, which requires visible text on every turn. Two
Golem-authored instructions, one telling the model to narrate and one forbidding
it. The proxy-injected one wins, because it arrives in the system block.

## The fix

One clause, appended to `SAFETY_TAIL` — the shared tail that already carries the
verbatim-payload and prose-style-only guards. It belongs there for two reasons:
a rule repeated in three profiles drifts, and this is a safety clause of the same
kind as the others. The existing tail stops a level talking the model out of
doing the work; this stops a level talking it into silence.

The clause permits **one short line** before a tool call, or before ending a turn
that would otherwise be tool calls only, and explicitly withholds what the
profiles removed: it may not restate the request, recap finished work, or offer
further help.

## Out of scope

- Changing what any profile does to ordinary prose. The registers are unchanged.
- The `off` default. A user who sets a level still gets that level.
