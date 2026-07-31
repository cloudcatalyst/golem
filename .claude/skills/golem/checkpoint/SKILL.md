---
description: Snapshot the working tree before a risky attempt so a failed one can be DISCARDED instead of repaired — opt-in shadow git refs, never a commit on the branch
invocationMode: user
---

The user wants to take, inspect, or roll back to a change-ledger checkpoint
(R8.9): $ARGUMENTS

Why this exists: repairing a failed attempt costs a read-diagnose-edit cycle AND
leaves the wreckage in context for every later turn. Discarding is cheaper. So
before a risky attempt (a wide refactor, a migration, a "let's try it" edit
across many files), take a checkpoint — then throw the attempt away if it fails
instead of unpicking it.

Run these with Bash:

- `golem checkpoint create --note "<what you are about to try>"` — cheap, and a
  no-op when nothing changed since the last one. Take one BEFORE the attempt.
- `golem checkpoint list` — what exists, newest first.
- `golem checkpoint show <id|latest>` — exactly what a restore would overwrite
  and delete. Read this before proposing a restore.
- `golem checkpoint restore <id|latest>` — **destructive and human-gated.** It
  is classified destructive (ADR-0002), so it always prompts; never pass
  `--yes` on the user's behalf. Propose it, show the plan, let them accept.

What it will NOT do: commit on the user's branch, stage anything, move HEAD, push
anything, or touch gitignored files. Snapshots live under
`refs/golem/ledger/*` and a restore only writes worktree files — after taking
one, `git diff refs/golem/ledger/<id>` is an ordinary diff. It degrades to a
no-op with a reason where it cannot be safe: no git, no repo, a detached HEAD, or
a dirty index (report that reason rather than working around it).
