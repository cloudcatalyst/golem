## Golem: task close-out must update SHIPPED + wiki

When closing a shipped task (`golem task done <id> --note …`):

1. **SHIPPED.md** — add a row to the releases table (what shipped, when, one-line outcome)
2. **Wiki debrief** — author `docs/wiki/debriefs/<date>-<id>-<slug>.md` with outcome, key lessons, sources, tags

Both are committed alongside the work, *before* the task-done command. Without them the knowledge base stays blind to the task.

See CLAUDE.md "Batch close-out" for the full checklist.