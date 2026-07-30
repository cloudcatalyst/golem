---
task: snooze-taskadd
title: Snooze enforcement denies the `golem task add` its own guidance rule asks for first
state: queued
owner: agent
size: S
design: docs/plan/proposals/golem-snooze.md; spec Decision 45; .claude/rules/golem-snooze-hold.md
gate: Either the documented step 1 succeeds under enforcement, or the rule stops asking for it. Observed live 2026-07-30 — do not close on reasoning alone; reproduce.
depends_on: []
touches: [src/hooks/, .claude/rules/golem-snooze-hold.md, src/cli/init.ts]
created: 2026-07-30
updated: 2026-07-30
---

## Goal

Make the snooze park procedure actually executable. Today its first step is denied by
its own second step.

## The defect, observed live (2026-07-30)

`.claude/rules/golem-snooze-hold.md` prescribes three steps at the usage limit:

1. **Document where you're up to** — `golem task add "<summary + next steps>"`, called
   "your safety net if the session ends before the reset".
2. **Snooze until the reset** — call the `snooze` MCP tool.
3. Stop and wait.

But Decision 45 made enforcement the default, and enforcement denies **every non-`snooze`
tool call** until the agent parks. `golem task add` runs through `Bash`. So step 1 is
denied by step 2's mechanism, and the agent is told to do something it cannot do.

Observed exactly this way mid-batch: the `Bash` call carrying a full resume note was
denied with the enforcement message, and the note had to be written into the assistant's
own chat message instead — which is precisely the safety net the rule was trying to
avoid relying on, since a message is lost if the session ends and a task file is not.

Fail-closed, never unsafe. But it makes the documented procedure wrong, and §96 already
recorded why that matters: *"a safety mechanism disabled out of irritation is a safety
problem."*

## Two fixes, and the choice is the task

- **A — exempt the documented step.** Allow the specific `golem task add` invocation
  (and only that) alongside `snooze`. Keeps the safety net. The risk is obvious and must
  be bounded: an exemption matched too loosely re-opens the hole enforcement exists to
  close, so match narrowly and never on a general `Bash` prefix.
- **B — drop step 1 from the rule** and lean on snooze resuming in-place with context
  intact. Simpler and honest, but it removes the stated protection for the case the rule
  itself calls out — the session ending *before* the reset.

A likely third option: have `snooze` itself persist the note, so parking and documenting
are one act rather than two. That would make the ordering problem structurally
impossible instead of exempted, and it fits the tool's existing shape (it already takes
the reset time and holds the session).

## Hard constraints

- Enforcement must stay **fail-closed**: a config read failure, a stale prediction, or an
  unparseable exemption must never widen what is allowed (Decision 45's safety valves).
- `snooze` stays exempt. Whatever else changes, that must not.
- Do not weaken the deny into an `ask` — Decision 45 chose enforcement deliberately, on
  the user's call.

## Definition of done

Reproduce the denial first (set the window artificially near the threshold or replay a
fresh limit state), then fix, then re-verify that step 1 completes and step 2 still
denies everything else. Update `.claude/rules/golem-snooze-hold.md`, the seeded copy in
`src/cli/init.ts`/`src/hooks/guidance.ts`, and `golem status`'s Limits line if the
behaviour changes.

## Out of scope

Reopening Decision 45 (enforcement-by-default is the user's call). Making the park
advisory. Any change to how the reset time is read from the rate-limit headers.
