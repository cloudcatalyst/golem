---
description: Batch close-out — verify green, rebuild + restart the running services, tidy the planning docs, write the debrief, retire the batch brief, then commit + open a PR
invocationMode: user
---

The user wants to close out a batch of work (the CLAUDE.md "Batch close-out"
checklist). Invoking this skill authorizes committing and opening a PR for this
batch. Do these in order; stop and surface any failure rather than pressing on.

1. **Verify green.** Run the `/golem/verify` steps (`npm run check` +
   `golem wiki check`), judged by exit code. Do not proceed until green.
2. **Deploy locally** so the *running* processes pick up the change:
   `npm run build` → `golem proxy restart`. Tell the user any live
   `golem mcp serve` connection must be reconnected by Claude Code; and if
   `vscode-extension/` changed, run `cd vscode-extension && npm run deploy:local`
   then reload the window. Skip the parts nothing touched.
3. **Tidy the planning docs.** Close the task and refresh the generated index:
   `golem task done <id> --note "<outcome>"` → `golem task index --write` →
   add a **table row** to `docs/plan/SHIPPED.md` under the releases table
   (`| title | date | outcome |` — multi-sentence, covering what shipped and
   why it matters). Never hand-edit the roadmap's index table (it is generated
   between the `golem:task-index` markers). Then update any living-doc
   references (CLAUDE.md, IMPLEMENTATION_PLAN, spec) to point at git history /
   shipped artifacts.
4. **Write the debrief.** Run `/golem/debrief` to author the dated
   `docs/wiki/debriefs/` page (wiki writes are un-gated, Decision 44). The
   debrief is required — without it the knowledge base stays blind to the task.
   Include: verdict, problem, fix/approach, key lessons/numbers, sources, tags.
5. **Retire the batch brief.** Delete the completed batch brief from the tree —
   git history preserves it; completed briefs are never kept in the tree.
6. **Commit + PR.** Conventional commits on a branch (never commit to `main`),
   one workstream per PR, PR body lists affected interfaces. Use the `gh` CLI:
   `gh pr create`, then `gh pr merge --squash` to match the repo's `(#N)`
   history. Record any spec Decisions Log change in `docs/golem-spec.md`.
