## Golem: task close-out must update SHIPPED + wiki

When closing a shipped task (`golem task done <id> --note …`):

1. **`docs/plan/SHIPPED.md`** — add a row (what shipped, when, one-line outcome). **Use that exact
   path.** Naming it without the directory is how a second, competing log grew at
   the repo root and ran for three weeks before anyone noticed; a drift test now
   fails if one reappears.
2. **Wiki debrief** — author `docs/wiki/debriefs/<date>-<id>-<slug>.md` with outcome, key lessons, sources, tags

Both are committed alongside the work, *before* the task-done command. Without them the knowledge base stays blind to the task.

See CLAUDE.md "Batch close-out" for the full checklist.