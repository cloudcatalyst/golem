/**
 * Doing the work: `develop` orchestrates a change end-to-end (research → draft
 * with the local coder → verify), `plan` turns captured notes and open questions
 * into agreed, plan-gated tasks.
 */

const develop = `---
description: Orchestrate building a feature or fix end-to-end — research the wiki/KB, draft code+tests with the coder tool, verify, iterate
invocationMode: auto
---

The user (or Claude's own judgment) has identified development work to do: $ARGUMENTS

1. **Research first.** Run the \`/golem/research\` skill (or its steps
   directly: \`wiki_read\` the likely page, else \`search\` + \`fetch\`) for the
   feature area so you understand existing patterns, prior decisions, and
   frozen interfaces before writing anything.
2. **Draft with \`coder\` first — but only when it pays.** Per this project's
   coder-first convention, call the \`coder\` MCP tool to draft non-trivial
   implementation and tests. The tool now **grounds** drafts in the local
   knowledge base automatically (relevant project/wiki hits are injected), so
   you usually don't need to hand-feed context — add \`context\` only for
   specifics search won't surface. For a genuinely non-trivial draft, pass
   \`refine: true\` to run a local judge→revise pass (it roughly doubles local
   latency, so it earns its keep only on real logic, not boilerplate). **Skip
   \`coder\` entirely** for trivial edits (a rename, a one-line fix, a tiny
   test tweak) — the round trip costs more than it saves.
3. **Review and finalize.** Treat the draft as a starting point, not a final
   answer — rewrite anything that doesn't fit this codebase's conventions
   (frozen interfaces, TS strict, zod at boundaries, no unneeded abstraction).
   Check the draft's \`grounding\`/\`refinement\` fields to see what it was based
   on and whether the local judge changed anything.
4. **Verify.** Run the project's check command (e.g. \`npm run check\` — lint
   + typecheck + test) via Bash. On failure, fix and re-run; use \`coder\`
   again for non-trivial fixes.
5. **Report** what changed and which files were touched. Don't commit unless
   asked.

Before a **wide or speculative** change (a refactor across several files, a
migration, a "let's see if this works"), take a checkpoint first: \`golem
checkpoint create --note "<the attempt>"\`. If it fails, propose discarding it
(\`/golem/checkpoint\`) instead of spending a repair cycle — the repair also
leaves its wreckage in context for every later turn.

If \`coder\`/\`research\` are unavailable, say the Golem MCP server isn't
connected and suggest \`golem init\` and restarting Claude Code.
`;

const plan = `---
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
   - Recent \`golem note\` captures: run \`golem note list\` via Bash (add
     \`-n <count>\` for more than the default 20, or \`--json\` for exact
     timestamps to cite).
   - Open questions: read the pages under \`docs/wiki/questions/\` (list the dir,
     Read each; or \`wiki_read\` a page by title).
   - Pending distill drafts: list \`.golem/distill/\` and Read the drafts (these
     are captured ideas/sources already shaped into draft wiki pages, not yet
     promoted).
   - The ideas inbox: Read \`docs/plan/BACKLOG.md\`.
   - Existing open work: run \`golem task index --summary\` via Bash. Every open
     item is a committed task document under \`docs/plan/tasks/\` (spec Decision
     55); \`golem task show <id>\` prints one in full. Do this before proposing
     anything, so you don't re-propose something already scheduled or blocked.
2. **Surface candidates, grouped by source.** For each, give a one-line
   statement and cite exactly where it came from (a note timestamp, a
   \`questions/<slug>.md\` page, a \`distill:<slug>\` draft, or this conversation).
   Note anything already covered by an existing task or BACKLOG entry instead of
   re-proposing it.
3. **Discuss with the user.** Ask which candidates are worth turning into tasks,
   what's out of scope, and what's missing. Let the user drive prioritization.
4. **Propose concrete entries** for the agreed items:
   - New rows for \`docs/plan/BACKLOG.md\` (Date / Idea / Source / Status — see
     that file's own "How this file works" for the exact format) for ideas that
     are not yet work, or
   - A new **task document** under \`docs/plan/tasks/<id>.md\` for items the user
     wants scheduled now — follow \`docs/plan/tasks/README.md\` for the
     frontmatter and the house style (goal, design source, gate, out-of-scope),
     then set the BACKLOG row's Status to \`promoted\` with the task id, and run
     \`golem task index --write\` to refresh the roadmap index.
5. **Plan-gate every write.** Show the exact edit (file + the lines to
   add/change) and wait for explicit approval before touching any plan file.
   Never edit \`BACKLOG.md\`, a task document, or \`ROADMAP.md\` unprompted.
   Append rows; don't rewrite or delete another entry's wording. **Never
   hand-edit the roadmap's index table** — it is generated between the
   \`golem:task-index\` markers; change the task document and regenerate.
6. **The planning contract** (mirrors the \`/golem/research\` query contract):
   cite a source for every proposed task, clearly flag what is your inference
   versus what the user actually stated, and admit gaps rather than inventing
   work to fill the page.

If the Golem MCP tools or CLI are unavailable, say the Golem MCP server isn't
connected and suggest \`golem init\` and restarting Claude Code.
`;

/** Skill name -> SKILL.md content, keyed as `/golem/<name>`. */
export const DEVELOP_SKILLS: Readonly<Record<string, string>> = {
  develop,
  plan,
};
