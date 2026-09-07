---
title: File Ownership Was Never the Boundary — Three Agents, One Checkout, Three Collisions
type: debrief
tags: [multi-agent, worktree, git, npm, process, guidance, subagents]
sources: [docs/plan/tasks/parallel-agent-isolation.md, src/hooks/guidance.ts, CLAUDE.md, docs/plan/tasks/settings-cascade-importance.md]
created: 2026-09-07
updated: 2026-09-07
---

# File ownership was never the boundary

Three agents were dispatched concurrently into one checkout to ship
`release-pr-needs-approval`, `skill-provenance-on-clone` and `team-portal-auth`.
All three landed (PRs #178, #179, #180). All three also collided with each
other, and **not one of the collisions was a file collision** — which is the only
kind the multi-agent rule warned about.

Pages touched: [[Configuration Surfaces]] · `CLAUDE.md` § Multi-agent.

## What the briefing got right, and why it did not help

Each agent was told which files it owned, warned about its siblings by name, and
told that `SHIPPED.md`, `WIKI.md` and `ROADMAP.md` are shared append points where
conflicts were expected. That was accurate and it prevented exactly the class of
problem it described. Every PR's final diff was clean of sibling *code*.

The damage came from three things nobody owns.

### 1. A checkout has ONE HEAD

Between one agent's `git checkout -b` and its first commit, another agent's
checkout moved the shared HEAD. Its commits landed on the sibling's branch, and
the sibling's `git add -A` swept up its files. The sibling's PR would have
carried a workflow change, a wiki page and a debrief belonging to someone else.

Cost: a rebase dropping two foreign commits, and a re-review of both branches.
Notably the affected agent *diagnosed this itself* and moved to a worktree —
after the contamination, not before.

### 2. `node_modules` is shared mutable state

The dev dependency tree was replaced by a published `golem-run` install — an
entirely reasonable thing for the skills agent to do, since its task is *about*
cloned-project behaviour. The global `golem` CLI then failed everywhere with
`Cannot find package 'commander' imported from …/dist/cli/program.js`.

Nothing that shipped was affected: every PR was verified from a private worktree
with its own 144-package tree. But the parent session could not regenerate
`ROADMAP.md` mid-rebase until `npm ci` finished — the CLI needed to resolve a
conflict was the CLI that was broken.

### 3. "Zero commits ahead" says nothing about a dirty tree

A fourth worktree showed zero commits ahead of `development`. It was described —
by me — as empty and queued for cleanup. It held **eight uncommitted files**
implementing a spec Decision (per-org team cache) that existed nowhere else, plus
an unrelated stash. `git worktree remove` would have destroyed all of it.

It survived only because an agent was asked to account for the worktree before it
was removed, and answered *"not mine, and please do not clean it up"* with the
diffstat to prove it. **The cleanup instinct was reading the wrong signal
entirely**, and a commit count is a signal that looks authoritative while
answering a different question.

## The fix, and why it is a seeded rule

Two of the three agents created their own worktree unprompted. The one that did
not is the one that got contaminated. That is the whole argument for putting it
in the dispatch prompt rather than hoping for good instincts:

```
git worktree add ../<repo>-<task> -b <branch> development
```

It ships as `parallel-agent-isolation`, a `seededByDefault` guidance feature, so
`golem init` writes it into any project — because multiple agents from different
sessions against one checkout is a common shape, not a quirk of this repo. The
rule names all three collisions, and the test asserts each of them separately: a
rule that only said "use a worktree" would have prevented the first two and left
the third intact.

## Lessons

1. **Isolate the shared state, not the shared files.** The question to ask before
   dispatching is not "who owns which files" but "what does this tool mutate
   process-wide" — HEAD, the index, `node_modules`, a daemon, a lockfile.
2. **A verification instinct is worth as much as a safety instinct.** Every
   agent's report here was accurate, and checking them anyway is what caught the
   contamination early and confirmed the credential handling in #180. The one
   thing that nearly went wrong was a claim *I* made without checking.
3. **Before deleting anything an agent created, ask the agent.** The cost of the
   question is one message; the cost of skipping it was nearly the only copy of a
   design decision.
4. **Merge one PR at a time, then re-check.** Shared append-only docs conflict
   between every pair, and `ROADMAP.md` must be regenerated rather than merged —
   it is generated, so a hand-resolution is a fabrication.
