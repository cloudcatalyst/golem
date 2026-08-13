/**
 * The batch close-out sequence, in the order CLAUDE.md runs it: verify green,
 * ship, promote the drafts, write the debrief.
 *
 * These encode a checklist whose steps are ordered for a reason — the tests pin
 * that ordering (verify before commit, distill before write).
 */

const verify = `---
description: Run the full green-check gate before committing — lint, typecheck, tests, and wiki lint — judged by EXIT CODE, not tailed output
invocationMode: user
---

The user wants to confirm the working tree is green before committing (the
batch close-out bar in CLAUDE.md).

Run these via Bash from the repo root, and judge each by its **exit code**, not
by the tail of its output — a run can print errors and still be misread as
passing if you only skim the tail (that mistake has broken CI in this repo
before):

1. \`npm run check\` — Biome lint + \`tsc --noEmit\` (strict) + vitest. If a
   step is split out, run \`npm run lint\`, \`npx tsc --noEmit\`, and
   \`npx vitest run\` separately and check each exit code.
2. \`golem wiki check\` — wiki frontmatter/date/link lint (only if any
   \`docs/wiki/\` page changed).

Report a short PASS/FAIL table with each step's exit code. On any non-zero exit,
show the failing output and stop — do not suggest committing. Fix the cause (use
the \`coder\` MCP tool for non-trivial fixes) and re-run. The tree is green only
when every step exits 0.
`;

const ship = `---
description: Batch close-out — verify green, rebuild + restart the running services, tidy the planning docs, write the debrief, retire the batch brief, then commit + open a PR
invocationMode: user
---

The user wants to close out a batch of work (the CLAUDE.md "Batch close-out"
checklist). Invoking this skill authorizes committing and opening a PR for this
batch. Do these in order; stop and surface any failure rather than pressing on.

1. **Verify green.** Run the \`/golem/verify\` steps (\`npm run check\` +
   \`golem wiki check\`), judged by exit code. Do not proceed until green.
2. **Deploy locally** so the *running* processes pick up the change:
   \`npm run build\` → \`golem proxy restart\`. Tell the user any live
   \`golem mcp serve\` connection must be reconnected by Claude Code; and if
   \`vscode-extension/\` changed, run \`cd vscode-extension && npm run deploy:local\`
   then reload the window. Skip the parts nothing touched.
3. **Tidy the planning docs.** Close the task and refresh the generated index:
   \`golem task done <id> --note "<outcome>"\` → \`golem task index --write\` →
   add a **table row** to \`docs/plan/SHIPPED.md\` under the releases table
   (\`| title | date | outcome |\` — multi-sentence, covering what shipped and
   why it matters). Never hand-edit the roadmap's index table (it is generated
   between the \`golem:task-index\` markers). Then update any living-doc
   references (CLAUDE.md, IMPLEMENTATION_PLAN, spec) to point at git history /
   shipped artifacts.
4. **Write the debrief.** Run \`/golem/debrief\` to author the dated
   \`docs/wiki/debriefs/\` page (wiki writes are un-gated, Decision 44). The
   debrief is required — without it the knowledge base stays blind to the task.
   Include: verdict, problem, fix/approach, key lessons/numbers, sources, tags.
5. **Retire the batch brief.** Delete the completed batch brief from the tree —
   git history preserves it; completed briefs are never kept in the tree.
6. **Commit + PR.** Conventional commits on a branch (never commit to \`main\`),
   one workstream per PR, PR body lists affected interfaces. Use the \`gh\` CLI:
   \`gh pr create\`, then \`gh pr merge --squash\` to match the repo's \`(#N)\`
   history. Record any spec Decisions Log change in \`docs/golem-spec.md\`.
`;

const promote = `---
description: Review pending distill drafts and promote them into the wiki — the last leg of capture → distill → promote
invocationMode: user
---

The user wants to promote captured/distilled drafts into durable wiki pages.
Optional filter: $ARGUMENTS

1. **List pending drafts.** Run \`golem wiki promote --list\` via Bash — it shows
   each \`.golem/distill/\` draft with its provenance (source note ts / URL), the
   target page path (routed from the draft's \`type\` → zone), and age.
2. **Review each candidate.** Read the draft. Check it is genuinely in our own
   words (no long quotes), carries real \`[[wikilinks]]\` to related pages, and
   does not contradict an existing page — surface any contradiction to the user
   rather than auto-resolving it (WIKI.md write rule).
3. **Promote on approval.** For each draft the user wants kept, run
   \`golem wiki promote <id> --yes\` — it writes through append-and-refine
   \`upsertPage\` semantics (union-merge frontmatter, dated separator, never a
   wholesale rewrite) and removes the consumed draft.
4. **Report** which drafts were promoted, to which pages, and which were left or
   dropped. If there are no pending drafts, say so and suggest \`/golem/research\`
   or \`golem note\` to capture something first.
`;

const debrief = `---
description: Author the dated wiki debrief for the work just completed — a diff-aware summary with wikilinks and any Decisions touched
invocationMode: user
---

The user wants a debrief page for the work just finished (the CLAUDE.md
close-out step). Optional slug/topic: $ARGUMENTS

1. **Gather what changed.** Look at the branch diff (\`git diff --stat\` and the
   key hunks via Bash) and the task/batch id you worked. Describe what actually
   changed — don't invent scope.
2. **Draft the page.** A debrief is a wiki page: \`type: debrief\`, filename
   \`YYYY-MM-DD-<slug>.md\` under \`docs/wiki/debriefs/\`. Keep it to: what
   shipped, why (the problem), key decisions/tradeoffs, and residual follow-ups.
   Add real \`[[wikilinks]]\` to every related concept/page and cite the source
   files/decisions. Redaction-before-storage still applies.
3. **Write it.** Call \`wiki_upsert\` with
   \`rel_path: "debriefs/YYYY-MM-DD-<slug>.md"\` and \`type: "debrief"\` — author
   it directly (wiki writes are un-gated, Decision 44); every write is committed
   to git and reviewable.
4. **Record decisions.** If the work changed a spec Decision, note that in
   \`docs/golem-spec.md\`'s Decisions Log too (that stays authoritative).
5. **Verify links.** Run \`golem wiki check\` via Bash so the new page's
   wikilinks resolve.
`;

/** Skill name -> SKILL.md content, keyed as `/golem/<name>`. */
export const CLOSE_OUT_SKILLS: Readonly<Record<string, string>> = {
  verify,
  ship,
  promote,
  debrief,
};
