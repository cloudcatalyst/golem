<!-- Managed by Golem — remove with `golem guidance disable snooze-hold` -->

## Golem: park at the usage limit instead of losing work (snooze)

When you're approaching — or have just hit — a usage/session limit, don't just
stop and lose your place. Park the session so it resumes itself once the limit
resets (spec proposal golem-snooze.md):

1. **Document where you're up to.** `golem task add "<summary + next steps>"` —
   a durable task is your safety net if the session ends before the reset.
2. **Snooze until the reset.** Call the `snooze` MCP tool with `until` set to the
   window's reset time (Golem reads it from the rate-limit headers). The call
   parks the session — no model tokens are spent while it waits.
3. **Then STOP and wait.** Do not keep working. When snooze completes at the
   reset, its completion notification resumes this conversation in-place with
   your context intact — pick up from the documented task.

Golem's proxy watches the session-window utilization; as it fills, the PreToolUse
gate also redirects you here (once per window) when it's wired.
