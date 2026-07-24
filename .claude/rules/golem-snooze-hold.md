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
gate redirects you here. **By default this is enforcing** (spec Decision 45):
every non-`snooze` tool call is denied until you park, so the only way forward is
to call the `snooze` tool — don't fight it, park. Set `snooze.enforce` false (env
`GOLEM_SNOOZE_ENFORCE=false`) for the advisory mode (a single one-shot nudge per
window). If the rate-limit feed goes cold (e.g. an account whose responses don't
carry the limit headers), Golem warns once that the auto-park is blind rather than
failing silently — watch Claude Code's own limit indicator and park manually.
Check `golem status` (the Limits line shows utilization, freshness, and
`park advisory|enforced`).
