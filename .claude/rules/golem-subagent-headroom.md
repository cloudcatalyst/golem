<!-- Managed by Golem — remove with `golem guidance disable subagent-headroom` -->

## Golem: a subagent cannot park — spend the window before you spend the agent

The usage-limit park is a **tool-call gate**. A subagent never reaches it: the
limit is hit on a *model request*, so a child's turn fails upstream (`Agent
terminated early due to an API error: You have hit your session limit`) before
it can propose a call to be denied. It gets no turn, writes no note, and takes
any uncommitted work with it. Observed 2026-08-22: two of three dispatched
agents died exactly that way, one word after "All green. Committing."

So the decision moves to the one part the parent *does* control:

1. **The spawn is gated on headroom.** Golem refuses a spawn when the session
   window cannot pay for it — a subagent has historically cost ~15–20% of a
   window (~171k–186k tokens over 85–94 tool calls). The refusal states what it
   measured; read the numbers rather than retrying. Do the work inline, or park
   with `snooze` and spawn after the reset. `snooze.spawn_gate` false (env
   `GOLEM_SNOOZE_SPAWN_GATE=false`) turns it off; `snooze.spawn_cost_fraction`
   tunes the estimate. `golem status`'s Limits line says whether spawns are
   `allowed`, `REFUSED` or `ungated`.
2. **Tell every dispatched agent to commit early.** The survivors survived
   *because* they had already committed. Put it in the prompt: commit working
   increments on your own branch as you go. That is commit early, not merge
   early — "one workstream per PR" still holds.
3. **When a child dies, capture its place.** A death is reported in the task
   notification. Turn that into a durable task naming what the child was doing
   and where it got to. The record survives even though the process does not —
   that is the honest version of resuming.

A missing or stale rate-limit reading makes the gate **blind**: it warns once
and lets a re-issued spawn through rather than assuming headroom. Treat that
warning as the signal to check Claude Code's own limit indicator yourself.
