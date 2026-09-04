---
task: release-pr-needs-approval
title: "The release PR cannot go green on its own — a bot-opened PR does not trigger CI, so every release stalls at `action_required`"
state: queued
owner: agent
size: S
discipline: code
design: "Observed 2026-09-04 cutting v0.50.0, the first real run of the pipeline in `docs/wiki/concepts/Release Pipeline.md`. GitHub deliberately does not trigger workflows for events raised with `GITHUB_TOKEN`, to stop workflows recursing."
gate: "Cutting a release requires no manual approval step — or, if the manual beat is kept deliberately, `release-prepare.yml` and the Release Pipeline page SAY so, and the PR body tells the human what they must click."
depends_on: []
touches: [.github/workflows/release-prepare.yml, docs/wiki/]
created: 2026-09-04
updated: 2026-09-04
---

## What happened

`release-prepare.yml` bumps the version and opens the release PR with
`gh pr create`, authenticated as `GITHUB_TOKEN`. GitHub will not let events
raised by that token start new workflow runs — the anti-recursion rule.

So on PR #158 the `CI gate` check sat at `action_required` with **zero jobs**,
`mergeStateStatus` was `BLOCKED`, and `gh pr checks` reported *"no checks
reported"*. Nothing was broken; nothing was going to happen either. It needed
`POST /actions/runs/{id}/approve` by hand.

Left as-is, **every release stalls in the same place**, and the symptom is
unhelpful: a required check that is neither passing nor failing, on a PR that
looks fine.

## The options

1. **`release-prepare` pushes the bump; a human opens the PR.** Smallest change,
   no new credential, and the human beat lands where it is cheapest. The workflow
   would print the compare URL to click.
2. **Open the PR with a PAT** stored as a secret. Fully automatic, at the cost of
   a long-lived credential with `repo` scope — and this project's own posture
   (ADR-0003) is that credentials live in a keychain, not in CI config.
3. **Keep the approval as a deliberate release checkpoint.** Defensible: a human
   confirming before anything is published is not obviously wrong for a step that
   pushes to npm and a public CDN path.

Option 3 is only acceptable **if it is written down**. Right now the workflow's
own comments describe the flow as automatic, which is the actual defect: the
behaviour and the documentation disagree, and the documentation is the one people
will believe.

## Out of scope

Changing what the release publishes. This is about how the PR reaches a state
where it can be merged.
