---
description: Graceful handoff at a usage limit — document where you're up to as a durable task, then park the session until the window resets
invocationMode: user
---

The user wants to stop deliberately (approaching a usage/session limit, or just
pausing) without losing their place — the manual counterpart to Golem's enforced
snooze gate.

1. **Document where you're up to.** Run
   `golem task add "<one-line summary + the exact next steps>"` via Bash — a
   durable task is the safety net if the session ends before you resume.
2. **Park until reset.** Call the `snooze` MCP tool with `until` set to the
   window's reset time (Golem reads it from the rate-limit headers; `golem status`
   shows utilization + freshness on its Limits line). The call parks the session
   with a heartbeat and spends no model tokens while it waits.
3. **Then STOP and wait.** Do not keep working. When snooze completes at the
   reset, its notification resumes this conversation in place with context
   intact — pick up from the task you wrote.

If the rate-limit feed is cold (no limit headers), `golem status` warns the
auto-park is blind — pick the reset time from Claude Code's own limit indicator
and park manually.
