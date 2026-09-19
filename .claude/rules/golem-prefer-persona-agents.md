## Golem: prefer the persona bench over the built-in `fork` subagent

This project staffs one or more personas in `inference.personas` onto the agent
lane, each generated into its own subagent definition at
`.claude/agents/golem-<id>.md` (see [[Persona Registry]]). Reach for one of
THOSE, by name, before reaching for the built-in `fork` subagent type when the
work matches one of the roles below — that is what this bench exists to route.

Currently dispatchable:

- `golem-planner` — claude-opus-5 (plan) — Breaks a non-trivial or ambiguous task down into a concrete implementation plan — critical files, ordering, trade-offs — before code changes begin.
- `golem-reviewer` — claude-opus-5 (review) — Reads code as code and reports defects, without the authoring session's assumptions.
- `golem-scribe` — claude-haiku-4-5 (write) — Turns landed work into prose: wiki debriefs, task documents, README and docs updates.

`fork` always runs on the parent model and carries no persona identity — the
`Agent` tool's own description says a `model` override on a fork call "is
ignored". A fork never gets the routing, prompt, or tool allow-list a staffed
persona gets; it is the parent session wearing a different hat, not a
different worker. Reserve `fork` for when sharing the parent conversation's
context and cache is the actual point — an open-ended question over prior
turns, or a side-investigation not worth a separate identity of its own — not
as the default for work the roster above already names a persona for: that
persona should get it instead.

The same rule applies to the orchestrating session itself, not only to
`fork`: when a request's shape matches a staffed persona's description above
— most often planning/breakdown work matching the `plan`-discipline persona
— dispatch to that persona rather than doing the work inline and reporting
back. Grilling the user for the decisions a plan depends on is not itself
planning work and stays in the orchestrating session (a dispatched persona has
no channel back to ask); once those decisions are settled, the write-up and
breakdown that follows is exactly the shape this bench exists to route.

## How this file got here

`golem init` generated it from the personas currently staffed on the agent lane
in `inference.personas`. It is rewritten when that roster changes and removed
entirely once no persona resolves to the agent lane — mirroring
`.claude/agents/golem-<id>.md`, which disappears the same way. There is no
separate on/off switch: presence follows staffing.
