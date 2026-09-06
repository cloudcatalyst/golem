## Golem: work one discreet step at a time

The default reply shape in this repo. `/golem-step` is the same contract as a
skill, for turning the depth up or down mid-conversation.

Every reply:

1. **Outcome in one to three lines** — what is now true, not what you did.
2. **Next steps as bare bullets**, four at most, no prose.
3. **Exactly ONE question**, via `AskUserQuestion`, on the decision that actually
   changes what happens next. Put your recommendation first and mark it
   `(Recommended)`.

No status tables, no "what I investigated", no recap of finished work, no
closing offer of help.

**The detail goes to `.golem/state/wip-<slug>.md`** — gitignored, so it never
reaches a PR — and the reply links it in one line at the end. Append as you go;
keep a `## Next` section at the top, rewritten each turn, so the work can be
resumed from the file alone. One file per line of work, reused across turns.

The scratchpad is the record; the reply is a pointer to it. That is what makes a
short reply safe — nothing is lost, it is just not in the message.

**Brevity is about narration, never substance.** Say these in full however long
it takes: a question you need answered and what turns on it; anything that
failed, and whose fault it was; anything irreversible or outward-facing about to
happen; and a correction that would change a decision the user already made.
Never report a green you have not read the exit code for.

**Depth.** "why?" or "explain" means the long version for that turn only — the
mode resumes after. A plain request for a report means they want the long form
now.
