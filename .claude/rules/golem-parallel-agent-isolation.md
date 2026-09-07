<!-- Managed by Golem — remove with `golem guidance disable parallel-agent-isolation` -->

## Golem: parallel agents need their own WORKTREE, not just their own files

Two agents in one checkout collide through git and npm — not through the
files each was told to own. Ownership rules do not prevent any of this,
because none of it is a file conflict.

1. **Give every dispatched agent its own `git worktree`, in the dispatch
   prompt, before it starts.**

   ```
   git worktree add ../<repo>-<task> -b <branch> development
   ```

   A checkout has ONE HEAD. Between agent A's `git checkout -b` and its first
   commit, agent B's checkout moves that HEAD — so A's commits land on B's
   branch, and B's `git add -A` sweeps up A's files. Undoing it costs a
   rebase and a re-review of both branches.
2. **A worktree brings its own `node_modules`, which is the point.** A shared
   dependency tree is shared mutable state: one agent installing a published
   build over the dev tree breaks the CLI for every other agent AND for you
   (`Cannot find package ... imported from .../dist/`). Repair with `npm ci`;
   prevent by not sharing.
3. **Never judge a worktree disposable by its commit count.** "Zero commits
   ahead" says nothing about a DIRTY TREE. Run `git -C <path> status --short`
   and `git stash list` before removing one — uncommitted design work that
   exists nowhere else looks exactly like an abandoned branch from the
   outside. Commit it on its own branch rather than deciding for the author.
4. **Shared append-only docs still conflict, and that is expected.** Resolve a
   log or an index by keeping BOTH sides. Never hand-resolve a GENERATED file
   — regenerate it (for the roadmap, `golem task index --write`).

Sequencing is the other half: merge one PR at a time, and re-check the next
PR's mergeability afterwards rather than assuming it still applies.

See also the subagent-headroom rule — a child cannot park at a usage limit, so
it must commit early on its own branch or its work dies with it.
