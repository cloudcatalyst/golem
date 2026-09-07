---
task: parallel-agent-isolation
title: "Parallel agents need their own worktree — file ownership does not stop a shared HEAD, a shared node_modules, or a deleted dirty tree"
state: done
owner: agent
size: S
discipline: code
design: "Written from a live incident: three concurrent agents dispatched into one checkout on 2026-09-06 (PRs #178/#179/#180). The existing rule this sits beside is `subagent-headroom` (`src/hooks/guidance.ts`), which covers the other half — a child cannot park at a usage limit, so it must commit early. CLAUDE.md § Multi-agent is the human-facing statement; the seeded rule is the shipped one."
gate: "The guidance is a SEEDED rule, not just a line in this repo's CLAUDE.md — `golem init` writes it into any project, because the failure mode belongs to anyone running more than one agent against one checkout. All three observed collisions are named in the snippet, and a test asserts each of them by the string a reader would search for; a rule that only said \"use a worktree\" would not have prevented the third."
depends_on: []
touches: [src/hooks/guidance.ts, .claude/rules/, CLAUDE.md]
created: 2026-09-07
updated: 2026-09-07
---

## Why this is a shipped rule and not a note

Three agents were dispatched concurrently into `D:\Personal\Repos\Golem` on
2026-09-06. Each was briefed with the existing multi-agent rule — claim the task
id, do not modify files another workstream owns — and that briefing was
**necessary and not sufficient**, because none of the three collisions that
followed was a file collision.

The user's framing, which this task adopts: *"it could be quite common for
multiple agents from different sessions [to be] working on the same code base"*.
That makes it a product concern, not a repo convention. So it ships as a
`seededByDefault` guidance feature that `golem init` writes into every project,
and CLAUDE.md carries the human-facing version for this repo.

## The three collisions

1. **Shared git HEAD.** A checkout has one. Between agent A's `git checkout -b`
   and its first commit, agent B's checkout moved it — so A's commits landed on
   B's branch, and B's `git add -A` swept up A's files. Undoing it cost a rebase
   of B's branch onto `development`, dropping two foreign commits, plus a
   re-review of both.
2. **Shared `node_modules`.** A published-package install replaced the dev tree,
   and the global `golem` CLI failed repo-wide with `Cannot find package
   'commander' imported from …/dist/cli/program.js`. Nothing that shipped was
   affected — every PR was verified from a private worktree with intact
   dependencies — but the parent session could not run the CLI until `npm ci`.
3. **A worktree judged disposable by its commit count.** One worktree showed
   ZERO commits ahead of `development` and was queued for removal. It held eight
   **uncommitted** files implementing a spec Decision that existed nowhere else;
   `git worktree remove` would have destroyed it. Caught only because an agent
   was asked to account for it before cleanup.

Two of the three agents created their own worktree unprompted. The one that did
not is the one that got contaminated — which is the argument for putting it in
the prompt rather than hoping.

## What shipped

- `PARALLEL_AGENT_ISOLATION` snippet + the `parallel-agent-isolation` feature in
  `src/hooks/guidance.ts`, `seededByDefault: true`.
- `.claude/rules/golem-parallel-agent-isolation.md`, written by the CLI itself
  (`golem guidance enable parallel-agent-isolation`) rather than by hand, so the
  committed file is byte-identical to what `golem init` produces.
- A test asserting each collision by the string a reader would search for, plus
  the `git worktree add` command and the generated-file trap.
- CLAUDE.md § Multi-agent.

## Out of scope

- Making Golem CREATE the worktree. This is guidance, not automation: an agent
  runner that silently relocated a user's checkout would be worse than the
  problem. The `snooze.spawn_gate` precedent is the shape a future automation
  would take, and it would need its own decision.
- The usage-limit half — that is `subagent-headroom`, already seeded, and this
  snippet cross-references it rather than restating it.
