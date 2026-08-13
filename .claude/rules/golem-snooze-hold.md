<!-- Managed by Golem — remove with `golem guidance disable snooze-hold` -->

## Golem: park at the usage limit (snooze)

At the limit, call the `snooze` MCP tool with `until` (reset time from rate-limit headers) and `note` (where you're up to + next steps). The note is filed as a durable local task *before* the wait. Then stop — don't keep working. When snooze completes at reset, the conversation resumes in-place.

Do NOT try `golem task add` first — enforcement denies almost every non-`snooze` tool call, which is why `note` exists on the tool.

Exceptions: `ToolSearch` and `expand` are permitted, because `snooze` is a deferred tool and denying the schema lookup made the one allowed call impossible (R9.23). Use them for that, nothing else.

By default this is **enforcing** (Decision 45): every other call denied until you park. Set `snooze.enforce` false or `GOLEM_SNOOZE_ENFORCE=false` for advisory (one nudge per window). `golem status` shows `park advisory | enforced`.
