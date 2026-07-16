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
   - Current plan: Read `docs/plan/ROADMAP.md` (and the active batch brief it
     points to) so you don't propose something already scheduled or done.
2. **Surface candidates, grouped by source.** For each, give a one-line
   statement and cite exactly where it came from (a note timestamp, a
   `questions/<slug>.md` page, a `distill:<slug>` draft, or this conversation).
   Note anything already covered by an existing ROADMAP/BACKLOG entry instead of
   re-proposing it.
3. **Discuss with the user.** Ask which candidates are worth turning into tasks,
   what's out of scope, and what's missing. Let the user drive prioritization.
4. **Propose concrete task entries** for the agreed items:
   - New rows for `docs/plan/BACKLOG.md` (Date / Idea / Source / Status — see
     that file's own "How this file works" for the exact format), or
   - A promotion into `docs/plan/ROADMAP.md` / the active batch brief for items
     the user wants scheduled now (then set the BACKLOG row's Status to
     `promoted` with the task ID).
5. **Plan-gate every write.** Show the exact edit (file + the lines to
   add/change) and wait for explicit approval before touching any plan file.
   Never edit `BACKLOG.md`, `ROADMAP.md`, or a batch brief unprompted. Append
   rows; don't rewrite or delete another entry's wording.
6. **The planning contract** (mirrors the `/golem/research` query contract):
   cite a source for every proposed task, clearly flag what is your inference
   versus what the user actually stated, and admit gaps rather than inventing
   work to fill the page.

If the Golem MCP tools or CLI are unavailable, say the Golem MCP server isn't
connected and suggest `golem init` and restarting Claude Code.
