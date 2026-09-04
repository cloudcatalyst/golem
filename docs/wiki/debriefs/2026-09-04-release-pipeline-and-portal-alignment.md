---
title: Release Pipeline And Portal Alignment — A Release Is A Merge, And The Block That Had Already Cleared
type: debrief
tags: [ci, release, github-actions, portal, team, config, npm, webhook, audit]
sources: [.github/workflows/ci.yml, .github/workflows/release.yml, .github/workflows/release-prepare.yml, src/cli/commands/config.ts, docs/plan/verification-notes.md, docs/wiki/concepts/Release Pipeline.md, docs/wiki/concepts/Portal Install Contract.md, docs/wiki/concepts/Team Layer.md]
created: 2026-09-04
updated: 2026-09-04
---

# Release pipeline and portal alignment — what shipped

One session, three connected pieces: aligning this repo with the portal being
built beside it, restructuring CI and release around a branch model, and
discovering that the blocker both were supposedly waiting on had already lifted.

Pages authored alongside: [[Release Pipeline]] · [[Portal Install Contract]] ·
[[Team Layer]].

## 1. The portal was already built, and had already decided the hard part

The portal (a separate private repository — Next.js 16, Clerk, Stripe, Nango,
Supabase, Vercel) carries its own `docs/api-contract.md`, `docs/team-config.md`
and `docs/deploy.md`. Reading them turned an expected design exercise into a
reconciliation. Full facts, dated: `verification-notes.md` §149.

**It had independently reached the same conclusion about team binding**: which
team a project belongs to is a property of the project, committed in
`.golem/settings.json`, with the credential staying per-person in the OS keychain
(ADR-0003's line). Two designs arriving at the same shape from opposite ends is
the strongest evidence either of them was right.

**And it corrected one of ours the same day.** A task written that morning
required a membership mismatch to *refuse*. The portal's rule is better and now
stands: *"a team link is an enhancement to a local-first tool. Nothing about it
may stop the proxy from starting."* Degrade, but never silently — the hazard is
someone believing they are under team policy when they are not, and a refusal
that stops the proxy trades a small problem for a large one.

Three facts the move to Vercel taught this repo, none of which the nginx config
knew: **on Windows `curl` is an alias for `Invoke-WebRequest`** (so the
PowerShell-first ordering does more work than its comment claimed); Vercel
compiles `has` header values as `^value$` **case-sensitively** with no `i` flag;
and the redirects must be **307s, not 308s**, because the right answer for `/`
depends on who is asking. `deploy/nginx/golem-run.conf` is now a reference
implementation, and `R7.6-infra` was re-pointed at the deployment that exists.

## 2. A release is a merge into `main`

```
working branch → PR → development → "Prepare release" → PR → main → released
```

`main` receives nothing but release PRs, so "merged" and "released" are the same
event and there is no second thing to remember.

**`release.yml` calls `ci.yml` rather than repeating it.** A second copy of the
checks drifts, and the first anyone would know is a release that passed checks
`development` would have failed.

**The version is decided before the PR is opened, not after the merge.**
`auto-bump.yml` bumped minor on every push to main; under this model that leaves
`package.json` one version ahead of the tag just cut, and the next release
computes its tag from a version no release ever used. It was **deleted, not
disabled** — two mechanisms writing the same version is precisely the drift this
repo keeps rediscovering.

**CI runs at the release boundary only** (USER DECISION): nothing on
`development`. The trade is roughly half the Actions minutes for a worse
diagnosis — a red release PR indicts everything merged since the last one, and
the recovery is `git bisect`, not a glance at a diff. What keeps it rare is
`golem verify` before every merge into `development`, which is now load-bearing
rather than advisory.

## 3. `config-schema.json` must not describe the machine that built it

The portal validates team settings against a schema asset attached to each
release, so `golem config schema --json` became a published artifact. It could
not ship as it stood: the output carries a header of absolute paths, the proxy
port, the upstream account and when a model was last served.

`--no-header` drops that block and the load `warnings` with it — both describe
the local machine, not the schema. The release renders it with **`--dir` *and*
`HOME`** pointed at an empty temp dir: `--dir` because this repo has its own
committed `.golem/settings.json` and rendering in the checkout would bake Golem's
config into everyone's schema, `HOME` because the user layer is
`~/.golem/settings.json`. The workflow then asserts no control carries a layer
other than `default`/`runtime` — a `project` layer is proof something leaked.

Generalisable: **an artifact that leaves the machine needs a different rendering
from the one that describes it**, and the cheapest way to be sure is to render it
somewhere that has nothing to describe.

## 4. The blocker had already cleared

CLAUDE.md had carried a suspended CI gate since 2026-08-22 with a local
substitute. It was stale. `gh run list`: last billing-shaped failure
2026-08-29T03:22:41Z (run `33231240422`, **2 seconds, zero steps**), first
success 2026-09-02T13:01:21Z, 21 successful runs since including `CI gate` itself
reporting success.

Nobody had to do anything. **A suspension with no expiry outlives its cause**,
and the only reason it was found is that something else needed to know whether
Actions ran. The gate is reinstated, keeping the diagnostic that will be needed
again: fast red jobs with **no steps** are a billing block, read the run's
*annotations*, not the logs — the logs do not exist, and `gh run view --log`
answers `log not found`, which reads like a tooling fault.

It cannot be detected from inside a workflow, because the workflow never starts.
That is why the note lives in a checklist rather than in a job.

## 5. What could not be set, and the audit that followed

Both enforcement APIs refuse on a private repository:

```
PUT  repos/cloudcatalyst/golem/branches/main/protection  → 403
POST repos/cloudcatalyst/golem/rulesets                  → 403
"Upgrade to GitHub Pro or make this repository public to enable this feature."
```

So `main` is protected by **convention only** — worth writing down, because the
failure mode is someone later assuming a merge *was* blocked when it was merely
discouraged. Default branch was set to `development`, which is what stops a
`gh pr create` with no `--base` silently targeting a release.

The user then moved to make the repository public, which resolves it. A history
audit ran first, because going public is irreversible for anything ever
committed:

- **No credential file ever committed** — no `.env`, `.pem`, `.key`, no npm
  token. `.npmrc` is tracked but holds only `save-exact` and `min-release-age`.
- **Every token-shaped hit is `src/pipeline/redaction-rules.ts`, test fixtures,
  or docs prose.** Expected: this is a redaction tool, so `sk-ant-`, `ghp_`,
  `AKIA`, `xoxb-` and `AIza` are its *patterns*.
- **No private key material.** `tests/unit/proxy-loopback-cert.test.ts` asserts on
  keys it generates at runtime. `.golem/loopback/` — the real machine-local CA and
  its private key — was gitignored at R9.12 and, checked against full history,
  **was never committed even before that**: the only files ever added under
  `.golem/` are `settings.json` (contents: `{}`) and `personas/scribe.md`.
- **Two residual exposures, neither a secret**: commit author emails are in
  history (inherent to git; changing them needs a rewrite), and the test fixtures
  could not be read directly — **Golem's own redaction strips them from tool
  output before the agent sees them**, which is the pipeline working as designed
  and simultaneously a limit on what an agent can audit. A human glance at the
  four redaction test files closes it.

## Lessons worth carrying

- **A suspension needs an expiry or an owner, or it outlives its cause.** This one
  survived five days past the block clearing and was still shaping decisions.
- **Two repos align on a contract, not on tooling.** Stating `golem.run`'s routes
  as behaviour is why the nginx → Vercel move cost nothing; a contract written as
  an nginx config would have been invalidated by it.
- **Published artifacts need their own rendering.** The interactive output and the
  distributed one are different documents that happen to share a command.
- **Check whether the blocker is still true before designing around it.** Two
  documents were written that morning asserting a billing block that had ended
  days earlier; both had to be corrected the same day.
