/**
 * Skills that exist because the obvious move is the wrong one.
 *
 * Switching upstream is not the model picker; parking at a usage limit cannot go
 * through `golem task add` (enforcement denies it); a risky attempt wants a
 * checkpoint before it, not a repair after it; and cheap work should be routed
 * locally before it spends paid tokens.
 */

const upstream = `---
description: Switch the upstream account/provider the correct way — golem gateway use (auto-restarts the proxy) + reconnect MCP, NOT the Claude Code model picker
invocationMode: user
---

The user wants to change which upstream account/provider Golem forwards to
(e.g. a different Anthropic account, or a Foundry/OpenRouter gateway).
Target: $ARGUMENTS

This is **not** the Claude Code model picker — that chooses a model within the
current account; Golem routes the whole request to a configured upstream. Do it
through Golem:

1. **List accounts.** Run \`golem gateway list\` via Bash — shows configured
   accounts, which is active, and whether each has a stored credential.
2. **Switch.** Run \`golem gateway use <id>\` (or \`golem gateway use none\` to
   revert to the top-level default). This **restarts the proxy automatically**
   so the switch takes effect — no separate \`golem proxy restart\` needed.
3. **Reconnect MCP.** Tell the user any live \`golem mcp serve\` connection must
   be reconnected by Claude Code for the change to reflect in the MCP tools.
4. **Confirm.** Report the now-active account and its upstream URL. If a provider
   has no stored credential, say so and give the fix
   (\`golem gateway login <id>\`) rather than leaving auth silently broken —
   there is no environment variable to export (spec Decision 47).
`;

const park = `---
description: Graceful handoff at a usage limit — park the session until the window resets, filing where you're up to as a durable task in the same call
invocationMode: user
---

The user wants to stop deliberately (approaching a usage/session limit, or just
pausing) without losing their place — the manual counterpart to Golem's enforced
snooze gate.

1. **Park and document in ONE call.** Call the \`snooze\` MCP tool with \`until\`
   set to the window's reset time (Golem reads it from the rate-limit headers;
   \`golem status\` shows utilization + freshness on its Limits line) AND
   \`note="<one-line summary + the exact next steps>"\`. The note is filed as a
   durable local task *before* the wait starts — the safety net if the session ends
   before you resume — and the call then parks the session with a heartbeat,
   spending no model tokens while it waits.
2. **Then STOP and wait.** Do not keep working. When snooze completes at the
   reset, its notification resumes this conversation in place with context
   intact — pick up from the noted task.

Don't reach for \`golem task add\` via Bash: under enforcement (Decision 45) every
non-\`snooze\` tool call is denied, so \`note\` is how the task gets written.

If the rate-limit feed is cold (no limit headers), \`golem status\` warns the
auto-park is blind — pick the reset time from Claude Code's own limit indicator
and park manually.
`;

const checkpoint = `---
description: Snapshot the working tree before a risky attempt so a failed one can be DISCARDED instead of repaired — opt-in shadow git refs, never a commit on the branch
invocationMode: user
---

The user wants to take, inspect, or roll back to a change-ledger checkpoint
(R8.9): $ARGUMENTS

Why this exists: repairing a failed attempt costs a read-diagnose-edit cycle AND
leaves the wreckage in context for every later turn. Discarding is cheaper. So
before a risky attempt (a wide refactor, a migration, a "let's try it" edit
across many files), take a checkpoint — then throw the attempt away if it fails
instead of unpicking it.

Run these with Bash:

- \`golem checkpoint create --note "<what you are about to try>"\` — cheap, and a
  no-op when nothing changed since the last one. Take one BEFORE the attempt.
- \`golem checkpoint list\` — what exists, newest first.
- \`golem checkpoint show <id|latest>\` — exactly what a restore would overwrite
  and delete. Read this before proposing a restore.
- \`golem checkpoint restore <id|latest>\` — **destructive and human-gated.** It
  is classified destructive (ADR-0002), so it always prompts; never pass
  \`--yes\` on the user's behalf. Propose it, show the plan, let them accept.

What it will NOT do: commit on the user's branch, stage anything, move HEAD, push
anything, or touch gitignored files. Snapshots live under
\`refs/golem/ledger/*\` and a restore only writes worktree files — after taking
one, \`git diff refs/golem/ledger/<id>\` is an ordinary diff. It degrades to a
no-op with a reason where it cannot be safe: no git, no repo, a detached HEAD, or
a dirty index (report that reason rather than working around it).
`;

const triage = `---
description: Do this the local-first way — attempt or draft it with the local model before spending paid tokens, escalate only when the local pass isn't enough
invocationMode: user
---

The user wants a piece of work done as cheaply as possible: $ARGUMENTS

Golem's stance is local-first (spec Decision 31 and the coder-first rule): the
paid model's tokens are for judgment the local model can't make. Route the work:

1. **Classify it.** Is it retrieval-shaped (a fact/lookup), code-drafting, or
   genuinely-hard reasoning?
   - **Lookup?** Use \`/golem/research\` — the wiki/KB may answer it with no
     model call at all.
   - **Code/tests?** Draft with the \`coder\` MCP tool first (it grounds on the
     local KB automatically); pass \`refine: true\` for non-trivial logic. Then
     review and finish it yourself.
   - **A queued/standalone sub-task?** Run it locally with \`golem task run\`
     (bounded local multiplexing) and \`golem task escalate\` only when the local
     pass is insufficient.
2. **Escalate deliberately.** When you do spend paid tokens, fold the local pass
   in as grounding rather than starting over — review, integration, and the hard
   call are what Claude is for.
3. **Report** what was done locally vs escalated, so the token split is honest.

If no local model is available (\`golem devices\` shows none), say so and proceed
normally — the practice degrades, it doesn't block.
`;

/** Skill name -> SKILL.md content, keyed as `/golem/<name>`. */
export const FOOTGUN_SKILLS: Readonly<Record<string, string>> = {
  upstream,
  park,
  checkpoint,
  triage,
};
