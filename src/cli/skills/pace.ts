/**
 * Pacing: how much of a turn reaches the user, and where the rest goes.
 *
 * `/golem-step` is a MODE, not an action — it changes the shape of every reply
 * for the rest of the session rather than doing a piece of work once. The
 * always-on default lives in `.claude/rules/golem-stepwise.md`; this skill is
 * how the depth gets turned up or down mid-conversation.
 */

const step = `---
description: Work one discreet step at a time — a short summary, a brief next-step list, and ONE question — with the detail written to a scratchpad instead of the reply
invocationMode: user
---

The user wants incremental hand-holding rather than a long report. Optional
argument: $ARGUMENTS — a depth hint (\`brief\`, \`normal\`, \`full\`) or the task to
start on. Treat anything else as the task.

This is a **mode**. It governs every reply for the rest of the session, not just
the next one, until the user says otherwise.

## The turn shape

1. **Outcome first, in one to three lines.** What is now true that was not true
   before. Not what you did — what it means.
2. **Next steps as bare bullets.** Four at most, no prose, no sub-bullets. If
   there are more than four, you are describing a plan, not a next step; put the
   plan in the scratchpad and list the first four.
3. **Exactly ONE question, via \`AskUserQuestion\`.** The single decision that
   actually changes what happens next. Recommend an option — make it first and
   mark it \`(Recommended)\` — so the user can agree in one click.

Nothing else. No status tables, no "what I investigated", no restating the
request, no closing offer of help.

## Where the detail goes

Write it to \`.golem/state/wip-<slug>.md\` (gitignored, so it never reaches a PR),
and link that path in the reply — one line, at the end.

- **Append as you go**, in the same turn you would have narrated. Findings,
  command output worth keeping, decisions taken and why, dead ends.
- **Keep a \`## Next\` section at the top** and rewrite it each turn, so a fresh
  agent — or the user tomorrow — can resume from the file alone.
- One file per line of work. Reuse it across turns; do not start a new one per
  reply.

The scratchpad is the record. The reply is a pointer to it. That is what makes
the short reply safe: nothing is lost, it is just not in the message.

## What still gets said in full

Brevity is about narration, never about substance. Say these in the reply
regardless of length:

- **A question you need answered**, and what changes based on the answer.
- **Anything that failed**, and whether it is your fault. Never report a green
  that you have not seen the exit code for.
- **Anything irreversible or outward-facing** you are about to do, or want the
  user to do — a merge, a publish, a release, a delete.
- **A correction** to something you told them earlier that would change a
  decision.

If the honest version needs a paragraph, write the paragraph.

## Depth

\`brief\` cuts the next-step bullets to two. \`full\` suspends the mode for one
turn — write the long version, then return to stepwise. The user asking "why?"
or "explain" is a \`full\` for that turn; it does not end the mode.

## Ending it

The mode holds until the user asks for something else. \`/golem-step full\` for a
single deep reply; a plain request for a report or a summary of everything means
they want the long form now — give it, then resume.
`;

export const PACE_SKILLS: Readonly<Record<string, string>> = {
  step,
};
