---
task: main-branch-enforcement
title: "`main` is protected by convention only — GitHub refuses both protection APIs on a private repo"
state: queued
owner: user
size: S
design: "Measured 2026-09-04 while wiring the release pipeline (`docs/wiki/concepts/Release Pipeline.md`). Both `PUT branches/main/protection` and `POST rulesets` answer 403 *\"Upgrade to GitHub Pro or make this repository public to enable this feature.\"*"
gate: "A PR into `main` with a red `CI gate` cannot be merged by clicking the button — not merely should not be."
blocked: "needs a plan change or a visibility change on the repository, both of which are the account owner's to make. An agent must not upgrade a plan or publish a private repository."
depends_on: []
touches: [CLAUDE.md, docs/wiki/]
created: 2026-09-04
updated: 2026-09-04
---

## The gap

The release model makes `main` special: every merge into it publishes a release.
Nothing stops a red one.

```
PUT  repos/cloudcatalyst/golem/branches/main/protection  → 403
POST repos/cloudcatalyst/golem/rulesets                  → 403
"Upgrade to GitHub Pro or make this repository public to enable this feature."
```

Branch protection and rulesets are both paid features for private repositories,
and `cloudcatalyst` is an Organization on a plan that does not include them.

So the merge gate is exactly what it has always been here: a line in CLAUDE.md's
close-out checklist saying `gh pr checks <n>` must show `CI gate` green. That is
a convention, not a wall. It is worth naming because the failure mode is someone
later assuming a merge *was* blocked when it was only discouraged — and because
the original `ci-billing-and-gate` task already recorded that "nothing
server-side blocks a red merge on a private repo without GitHub Pro".

## The three options

1. **Upgrade the org plan.** Smallest change, costs money, everything else stays.
2. **Make the repository public.** Free protection *and* free Actions minutes for
   standard runners — which would also retire the whole minutes-conscious posture
   (Ubuntu-only CI, 10 shards chosen for cost, CI now skipped on `development`).
   The portal's own README already calls the harness "the other half … separate
   repo, open source", so this may be the intended destination anyway.
   **It needs a secrets and history audit first** — the repo has a committed
   `.golem/settings.json`, a `deploy/` tree, and 100+ commits of wiki prose. Going
   public is irreversible in practice: anything ever committed stays retrievable.
3. **Keep the convention** and accept that the gate is honoured, not enforced.

## Why an agent must not choose

Changing a billing plan and publishing a private repository are both outward,
credentialed acts with consequences an agent cannot take back — the same class as
`R7.5` (npm publish) and `R7.6-infra` (DNS).

## If option 2 is chosen

Do the audit as its own task before flipping the switch, and treat the CI
posture as re-openable afterwards: several deliberate cost decisions
(`docs/wiki/concepts/Release Pipeline.md`, and the shard-count comment in
`.github/workflows/ci.yml`) exist only because minutes are billed.
