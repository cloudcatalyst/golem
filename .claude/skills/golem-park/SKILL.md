---
description: Graceful handoff at a usage limit — park the session until the window resets, filing where you're up to as a durable task in the same call
invocationMode: user
---

The user wants to stop deliberately (approaching a usage/session limit, or just
pausing) without losing their place — the manual counterpart to Golem's enforced
snooze gate.

1. **Park and document in ONE call.** Call the `snooze` MCP tool with `until`
   set to the window's reset time (Golem reads it from the rate-limit headers;
   `golem status` shows utilization + freshness on its Limits line) AND
   `note="<one-line summary + the exact next steps>"`. The note is filed as a
   durable local task *before* the wait starts — the safety net if the session ends
   before you resume — and the call then parks the session with a heartbeat,
   spending no model tokens while it waits.
2. **Then STOP and wait.** Do not keep working. When snooze completes at the
   reset, its notification resumes this conversation in place with context
   intact — pick up from the noted task.

Don't reach for `golem task add` via Bash: under enforcement (Decision 45) every
non-`snooze` tool call is denied, so `note` is how the task gets written.

If the rate-limit feed is cold (no limit headers), `golem status` warns the
auto-park is blind — pick the reset time from Claude Code's own limit indicator
and park manually.
