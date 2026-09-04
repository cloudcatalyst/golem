---
title: Release Pipeline
type: concept
tags: [ci, release, branches, npm, github-actions, portal, webhook]
sources: [.github/workflows/ci.yml, .github/workflows/release.yml, .github/workflows/release-prepare.yml, scripts/release.mjs, src/cli/commands/config.ts]
created: 2026-09-04
updated: 2026-09-04
---

# Release Pipeline

How work reaches a release, and what a release publishes. The one-line version:

```
working branch → PR → development → "Prepare release" → PR → main → released
```

**A release IS a merge into `main`.** `main` receives nothing but release PRs, so
"merged" and "released" are the same event and there is no second thing anyone
has to remember to do.

Related pages: [[Portal Install Contract]] · [[Team Layer]] · [[Dogfooding Golem]].

---

## The three workflows

| workflow | trigger | does |
|---|---|---|
| `ci.yml` | PR to `main`; **`workflow_call`** | lint, typecheck, build, wiki lint, 10 sharded test jobs × 2 node versions, then one `CI gate` job |
| `release-prepare.yml` | manual, on `development` | bumps the version, pushes it, opens the release PR |
| `release.yml` | push to `main` (i.e. the release PR merging) | calls `ci.yml`, tags, builds, publishes, notifies |

`release.yml` **calls** `ci.yml` rather than repeating it. A second copy of the
checks would drift, and the first anyone would know is a release that passed
checks `development` would have failed.

## CI runs at the release boundary only

**USER DECISION, 2026-09-04.** Nothing runs on `development`: no PR check, no
push check. CI runs on the release PR into `main`, and again inside `release.yml`
after that PR merges.

The trade is roughly half the Actions minutes, and the cost lands on whoever cuts
the release: **a red release PR indicts everything merged since the last one**,
not one diff. The recovery is `git bisect` over `development`, not a glance at a
changed file.

What keeps that rare is the local gate. `golem verify` before every merge into
`development` runs the same seven checks the workflow does, judged by exit code —
that is now the only thing standing between a bad merge and a release PR that
cannot say which change broke it.

There is deliberately **no `push:` trigger at all**: a push to `main` runs the
release, and the release calls CI itself.

## Why the version is decided before the PR, not after the merge

The old `auto-bump.yml` bumped the minor version on every push to `main`. Under
this model every push to main is a release, so bumping *afterwards* would leave
main's `package.json` one version ahead of the tag just cut, and the next
release would compute its tag from a version no release ever used.

So `release-prepare.yml` bumps on `development` **before** opening the PR, which
also means the PR title says what is being released — which is what a human
reviewing it needs to see. `auto-bump.yml` was deleted rather than disabled: two
mechanisms writing the same version is exactly the drift this repo keeps
rediscovering.

`scripts/release.mjs` moves `package.json`, `vscode-extension/package.json` and
the compiled-in `VERSION` constant together, so all three move or none do.

**Merge the release PR with a merge commit, not a squash.** A squash rewrites the
history `development` is built on, and the branches then diverge permanently —
every later release PR would show the whole delta again.

## What a release publishes

Every one of these is load-bearing for `golem.run`, which redirects to
`releases/latest/download/…`. An asset missing here is a 404 on the front door.

| asset | who fetches it |
|---|---|
| `install.sh`, `install.ps1` | the bare domain, by User-Agent |
| `golem-linux-x64`, `golem-linux-arm64`, `golem-darwin-x64`, `golem-darwin-arm64`, `golem-windows-x64.exe`, `golem-windows-arm64.exe` | `/bin/<asset>`, tier 2 of the install ladder |
| `SHA256SUMS` | anyone verifying a binary |
| `golem-run-<version>.tgz` | proof the package packs; an install path before npm |
| `config-schema.json` | the portal, to validate team settings |

The release job **asserts** every required asset is present after uploading,
rather than trusting the upload. npm publish and the VS Code publish stay
optional — skipped unless `NPM_TOKEN` / `VSCE_PAT` are set — so the release is
complete either way, and turning on npm is setting one secret.

## `config-schema.json` must not describe the build machine

`golem config schema --json` normally carries a header full of machine state:
absolute paths, the proxy port, the upstream account, when a model was last
served. That is right for `golem status` and wrong for an artifact every
consumer downloads.

So the release renders it with `--no-header`, and with **both** the project
directory and `HOME` pointed at an empty temp dir — the project dir because this
repo has its own committed `.golem/settings.json` (rendering in the checkout
would bake Golem's own config into everyone's schema), and `HOME` because the
user layer is `~/.golem/settings.json`. With both isolated every value is a
built-in default.

The workflow then asserts no layer other than `default`/`runtime` appears. A
value carrying layer `project` is proof something local leaked.

## The portal webhook

The portal is told a new schema exists rather than polling for it.

`POST` to `PORTAL_WEBHOOK_URL`, signed with `PORTAL_WEBHOOK_SECRET`:

| header | value |
|---|---|
| `x-golem-timestamp` | unix seconds |
| `x-golem-signature` | `sha256=<hex>` of `HMAC-SHA256(secret, "<timestamp>.<raw body>")` |

The timestamp is inside the signed material, so a captured POST cannot be
replayed later. Body:

```json
{
  "event": "release.published",
  "tag": "v0.48.0",
  "version": "0.48.0",
  "repository": "cloudcatalyst/golem",
  "commit": "<sha>",
  "released_at": "<iso8601>",
  "config_schema": { "url": "https://…/config-schema.json", "sha256": "<hex>" },
  "assets": { "install_sh": "https://…/install.sh", "install_ps1": "https://…/install.ps1" }
}
```

Three properties worth keeping when the portal side is built:

- **It runs after the release is published**, in its own job. A webhook failure
  cannot unpublish anything — it goes red, visibly, instead of the portal
  silently serving a stale schema forever.
- **It retries 5xx and gives up on 4xx.** A rejected signature is a bug, and
  retrying a bug three times just delays finding it.
- **It is inert until both secrets are set**, and refuses to send unsigned if the
  URL is set without the secret — an unsigned webhook is one the portal must
  refuse anyway.

The portal verifies the signature, then fetches `config_schema.url` and checks it
against `sha256` before caching it by `version`.

## Repository settings

Set 2026-09-04:

- **Default branch: `development`**, so `gh pr create` and the web UI base on it.
  Without that, a PR raised with no explicit `--base` targets `main`, which now
  means "release".
- **`main` requires the `CI gate` check**, with force-pushes and deletions
  blocked. `development` requires nothing, matching the decision that CI runs
  only at the release boundary.

That protection took two attempts and is worth recording, because the first one
failed for a reason no amount of retrying would fix:

```
PUT  repos/cloudcatalyst/golem/branches/main/protection  → 403
POST repos/cloudcatalyst/golem/rulesets                  → 403
"Upgrade to GitHub Pro or make this repository public to enable this feature."
```

Branch protection and rulesets are paid features **for private repositories**.
The repo was made public the same day, and the identical call then succeeded. So
between the release model landing and the repo going public, `main` was protected
by convention only — a gap that existed and is now closed.

The single `CI gate` job is what makes this workable: protection names one check,
however the shard matrix is tuned. Pinning the 22 individual job names would break
every merge the moment the shard count changed, and it is explicitly a tuning
dial.

## When Actions stops for a reason that is not your code

Actions was billing-blocked from 2026-08-22 to somewhere between 2026-08-29 and
2026-09-02, and the failure mode is worth keeping because it will recur.

**Jobs fail in 1–5 seconds with no steps at all**: *"The job was not started
because recent account payments have failed or your spending limit needs to be
increased"*. No code ran, so the red says nothing about the change. Read the
run's **annotations** (`gh run view <id>`), not the logs — the logs do not exist,
and `gh run view --log` answers `log not found`, which reads like a tooling
fault.

It cannot be caught from inside a workflow, because the workflow never starts.
The detection is external and human, which is why the note lives in CLAUDE.md's
close-out checklist rather than in a job.

While it lasts the gate moves local — `golem verify`, judged by exit code — and
merging on a green local run is allowed. Merging on an unrun one is not.
