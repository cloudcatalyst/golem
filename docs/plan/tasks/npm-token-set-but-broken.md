---
task: npm-token-set-but-broken
title: "`NPM_TOKEN` is set but does not work — so every release attempts a publish and goes red after succeeding"
state: queued
owner: user
size: S
discipline: code
design: "Observed 2026-09-04 on run 33855109816 (the old Release workflow, re-triggered by the `v0.1.1` tag force-push during the history rewrite). The step named *\"Publish (skipped without NPM_TOKEN)\"* did not skip — it ran and failed, which is only possible if `env.NODE_AUTH_TOKEN` was non-empty."
gate: "Either `npm view golem-run version` resolves after a release, or the publish step genuinely skips and the release run is green end to end."
blocked: "changing or removing a repository secret is a credentialed act only the account owner can take"
depends_on: []
touches: [.github/workflows/release.yml]
created: 2026-09-04
updated: 2026-09-04
---

## What the evidence says

The publish step is guarded by `if: ${{ env.NODE_AUTH_TOKEN != '' }}`. It **ran**,
so the secret exists. It **failed**, so the token does not authenticate — expired,
revoked, wrong scope, or for a different registry or package name.

Nothing was published: `npm view golem-run` answers `404 Not Found`, so the name is
still unclaimed on the registry. **No unintended publish occurred.**

## Why it matters more than it looks

The order in the new `release.yml` is: create the GitHub Release, *then* publish.
So a broken token produces **a successful release with a red run**. That is the
worst of both worlds — the artifacts are live, and the signal that would tell you
something is wrong has been pre-spent on a failure everyone learns to ignore.

A red run that is expected to be red is not a signal. It is training.

## The options

1. **Delete the secret** until npm publishing is actually wanted. The step returns
   to genuinely skipping, and the release run goes green end to end. This matches
   the stated intent — publishing was explicitly deferred.
2. **Fix the token** (`npm token create`, repo secret `NPM_TOKEN`) and let v0.50.1
   be the first published version. Note `R7.5` — the first npm publish — is
   `owner: user` precisely because it is an outward, credentialed act.

Do not "fix" this by making the job `continue-on-error`. That hides a real failure
in the one workflow whose whole job is to be trustworthy.

## Related

`R7.5` (first npm publish + VS Code Marketplace publish + tag) is the task that
owns actually going live on the registry. This one only concerns the secret being
present-but-broken while publishing is meant to be off.
