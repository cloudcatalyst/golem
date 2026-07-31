---
title: Change Ledger
type: concept
tags: [git, checkpoint, undo, context-economy, autonomy, r8]
sources: ["src/checkpoint/", "src/cli/checkpoint.ts", "src/autonomy/classify.ts", "docs/plan/tasks/R8.9.md", "docs/plan/proposals/r8-context-economy.md (R8d)"]
created: 2026-07-31
updated: 2026-07-31
---

# Change Ledger

`golem checkpoint` snapshots the working tree into a **shadow git ref** so a failed
attempt can be **discarded instead of repaired**. Shipped in R8.9. It writes nothing
until you run it, and it never commits on your branch.

```
golem checkpoint create --note "before refactoring the parser"
golem checkpoint list
golem checkpoint show   <id|latest>      # exactly what a restore would do
golem checkpoint restore <id|latest>     # destructive — prompts, and is itself undoable
golem checkpoint drop <id> · golem checkpoint prune --keep 20
```

## Why it is a context-economy feature, not a git feature

Repairing a failed attempt costs a full read-diagnose-edit cycle **and** leaves the
wreckage in the context window for every later turn — and ~83% of input cost is
re-reading (§93, see [[Cache Observability]]). Discarding costs one command. Before
R8.9 there was no mechanism for discarding, so every dead end was repaired.

That is also why the ledger has **no MCP tool**: a tool definition bills on every
request (§88/§100), and the model can reach the CLI through `Bash` for free. The
[[Guidance Rules]] half is a `/golem/checkpoint` skill plus one paragraph in
`/golem/develop` telling the model to checkpoint *before* a wide or speculative
change.

## What it does and does not touch

| touched | never touched |
|---|---|
| `refs/golem/ledger/<id>` (a commit object) | `refs/heads/*` — no branch, no commit of yours |
| worktree files, on a restore only | the index — staging happens in a throwaway `GIT_INDEX_FILE` |
| empty directories left by a deletion | `HEAD` — it never moves |
| — | `.golem/` state, excluded by pathspec whether ignored or not |
| — | anything remote: git's default refspecs do not carry `refs/golem/*` |

The snapshot is a real commit parented on `HEAD`, so ordinary git works on it
unchanged: `git diff refs/golem/ledger/<id>`, `git show <id>`.

## The safety properties

1. **Opt-in.** Nothing runs until an explicit `golem checkpoint …`.
2. **Loud before acting.** A restore prints every file it will overwrite and every
   file it will delete, then asks. Non-interactive runs refuse without `--yes`
   (the Decision 26 consent convention, as in `golem wiki promote`).
3. **Human-gated for an agent.** `golem checkpoint restore|undo|drop|prune` classifies
   as `destructive` in the autonomy classifier (`src/autonomy/classify.ts`), which is
   in ADR-0002's never-auto set — no autonomy level approves it, and `ask` overrides an allow-list.
   Taking a checkpoint stays unclassified-cheap, because a gate on the *safe* half
   would stop the model doing it at all.
4. **A restore is itself undoable.** It takes a `pre-restore` checkpoint first and
   prints the command that reverses it.
5. **Refuses rather than half-acts.** No git, not a repo, a **detached HEAD**, or a
   **dirty index** → a no-op naming the reason. A dirty index is refused because a
   restore writes worktree files: staged content would then describe a state that no
   longer exists on disk.
6. **Bounded.** Auto-prunes to the 50 newest on create; re-checkpointing an unchanged
   tree reuses the existing ref instead of writing a duplicate.

## One documented consequence: line endings

Snapshot and restore go through git's own clean/smudge filters, so a restored file
gets the line endings **git would give it** (`core.autocrlf`, `core.eol`,
`.gitattributes`) — on a machine with `autocrlf=true`, an LF-only working copy comes
back CRLF. That is exactly what `git checkout` does, which is the behaviour to match,
but it is worth knowing before blaming the ledger for a whitespace diff.

## Related

- [[Cache Observability]] — where the "repairs are expensive" number comes from
- `docs/decisions/ADR-0002-autonomy-approval-gates.md` — the threat model whose
  never-auto set gates the destructive half
- [[Context Ledger]] — a different ledger (what the context is *made of*, R8.4);
  the CLI is named `checkpoint`, not `ledger`, to keep the two apart
- [[Dogfooding Golem]] — this repo commits only when asked, which is the constraint
  that made shadow refs the only acceptable design
