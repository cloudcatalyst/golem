---
task: ci-billing-and-gate
title: GitHub Actions is billing-blocked — clear it, then reinstate the CI merge gate
state: queued
owner: user
size: S
design: No design. Found 2026-08-22 when every job on PR #126 failed in 1–3s with a GitHub billing annotation rather than a test error. The gate it suspends is the last item of CLAUDE.md's "Batch close-out".
blocked: outward, credentialed act — only the account owner can change GitHub billing or a spending limit
depends_on: []
touches: [CLAUDE.md, .github/workflows/]
created: 2026-08-22
updated: 2026-08-22
---

## What happened

Mid-session on 2026-08-22, Actions stopped running. PRs #121–#125 ran and merged
green; #126, minutes later, produced three red jobs in 1–3 seconds each with:

> The job was not started because recent account payments have failed or your
> spending limit needs to be increased. Please check the 'Billing & plans'
> section in your settings

The test matrix showed `skipping`. **No code was executed**, so nothing about the
red was a signal about the change.

This had already been recorded once — R7.3's `blocked` reason says "CI is
billing-blocked so it cannot run there either" — so this is a recurrence, not a
new condition.

## Why this is a task and not a footnote

CLAUDE.md's close-out checklist made `gh pr checks <n>` green **the** merge gate,
precisely because nothing server-side blocks a red merge on a private repo
without GitHub Pro. That gate is now unrunnable, and it was suspended by user
decision on 2026-08-22 with a local substitute written into the checklist.

A suspended gate that nobody reinstates is worse than no gate, because the
checklist still *reads* as though something is checking. So the reinstatement is
owned work, not an intention.

## The trap for whoever sees this next

**Three jobs failing in under five seconds is a billing block, not a
regression.** Read the run's ANNOTATIONS (`gh run view <id>`), not the job logs —
the logs do not exist, because the jobs never started, and `gh run view --log`
answers `log not found`, which reads like a tooling fault. Diagnosing this cost
several minutes of chasing a phantom test failure.

## What to do

1. **Clear the block** — Billing & plans in GitHub settings: the failed payment,
   or the Actions spending limit.
2. **Confirm Actions runs again** on a throwaway PR, and that `CI gate` reports.
3. **Reinstate the gate** in `CLAUDE.md`: restore the original line and delete the
   suspension block, keeping the "three fast red jobs = billing" note somewhere —
   it will happen again.
4. **Consider making it fail loudly.** The failure mode that hurt here is that a
   billing block looks like a code failure while a *merge* looks fine. Options
   worth a thought, none obligatory: a workflow-level check that annotates
   plainly, or a note in the close-out checklist. Do not disable the workflow —
   leaving it enabled is what makes CI resume by itself when billing clears.

## Out of scope

Moving CI to another provider. Reducing the shard count to save minutes — the
10× sharding exists because the suite takes ~101s locally and much longer
serially in CI; that is a separate, measured decision.

## Gate

`gh pr checks <n>` reports a real `CI gate` result again, and `CLAUDE.md` no
longer says the gate is suspended. Until then the local sequence in the checklist
is the gate, and every merge must show it was run.
