---
description: Turn captured notes, open questions, and distill drafts into concrete tasks — together, plan-gated
invocationMode: user
---

The user wants a collaborative planning session. Optional focus topic: $ARGUMENTS

This closes the second-brain loop into tasks (spec Decision 36). Your job is to
surface candidate work from what Golem has already captured, discuss it with the
user, and — only with approval — record agreed tasks in the plan docs. You are a
co-pilot here: the human decides what becomes a task.

1. **Gather inputs (read-only — read, never write in this step).** If a focus
   topic was given, prioritize inputs matching it, but still skim the rest.
   - Recent `golem note` captures: run `golem note list` via Bash (add
     `-n <count>` for more than the default 20, or `--json` for exact
     timestamps to cite).
   - Open questions: read the pages under `docs/wiki/questions/` (list the dir,
     Read each; or `wiki_read` a page by title).
   - Pending distill drafts: list `.golem/distill/` and Read the drafts (these
     are captured ideas/sources already shaped into draft wiki pages, not yet
     promoted).
   - The ideas inbox: Read `docs/plan/BACKLOG.md`.
   - Existing open work: run `golem task index --summary` via Bash. Every open
     item is a committed task document under `docs/plan/tasks/` (spec Decision
     55); `golem task show <id>` prints one in full. Do this before proposing
     anything, so you don't re-propose something already scheduled or blocked.
2. **Surface candidates, grouped by source.** For each, give a one-line
   statement and cite exactly where it came from (a note timestamp, a
   `questions/<slug>.md` page, a `distill:<slug>` draft, or this conversation).
   Note anything already covered by an existing task or BACKLOG entry instead of
   re-proposing it.
3. **Discuss with the user.** Ask which candidates are worth turning into tasks,
   what's out of scope, and what's missing. Let the user drive prioritization.
4. **Propose concrete entries** for the agreed items:
   - New rows for `docs/plan/BACKLOG.md` (Date / Idea / Source / Status — see
     that file's own "How this file works" for the exact format) for ideas that
     are not yet work, or
   - A new **task document** under `docs/plan/tasks/<id>.md` for items the user
     wants scheduled now — follow `docs/plan/tasks/README.md` for the
     frontmatter and the house style (goal, design source, gate, out-of-scope),
     then set the BACKLOG row's Status to `promoted` with the task id, and run
     `golem task index --write` to refresh the roadmap index.
5. **Plan-gate every write.** Show the exact edit (file + the lines to
   add/change) and wait for explicit approval before touching any plan file.
   Never edit `BACKLOG.md`, a task document, or `ROADMAP.md` unprompted.
   Append rows; don't rewrite or delete another entry's wording. **Never
   hand-edit the roadmap's index table** — it is generated between the
   `golem:task-index` markers; change the task document and regenerate.
6. **The planning contract** (mirrors the `/golem-research` query contract):
   cite a source for every proposed task, clearly flag what is your inference
   versus what the user actually stated, and admit gaps rather than inventing
   work to fill the page.

If the Golem MCP tools or CLI are unavailable, say the Golem MCP server isn't
connected and suggest `golem init` and restarting Claude Code.
