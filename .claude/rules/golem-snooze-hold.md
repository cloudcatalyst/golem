<!-- Managed by Golem — remove with `golem guidance disable snooze-hold` -->

## Golem: park at the usage limit (snooze)

At or near a usage/session limit, park instead of stopping and losing your
place. Call the `snooze` MCP tool with `until` (the window's reset time, which
Golem reads from the rate-limit headers) AND `note="<where you're up to + next
steps>"` — ONE call. The note is filed as a durable local task *before* the
wait, so your place survives even if the session ends; no tokens are spent
waiting. Then STOP. At the reset, snooze's completion resumes this conversation
in-place — pick up from the noted task.

Do NOT try `golem task add` first: enforcement denies almost every non-`snooze`
call, `Bash` included, which is why `note` exists on the tool. `ToolSearch` and
`expand` are the exceptions — `snooze` is a deferred tool, and denying the
schema lookup made the one allowed call impossible (R9.23). Use them for that,
nothing else.

**Enforcing by default** (Decision 45): every other call is denied until you
park — don't fight it. `snooze.enforce` false (or `GOLEM_SNOOZE_ENFORCE=false`)
makes it advisory: one nudge per window. If the rate-limit feed goes cold (an
account whose responses carry no limit headers), Golem warns once that the
auto-park is **blind** rather than failing silently — watch Claude Code's own
limit indicator and park manually. `golem status` shows utilization, freshness
and `park advisory|enforced`.
