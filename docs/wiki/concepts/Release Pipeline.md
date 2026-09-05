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

## Where CI runs, and why that changed twice in a day

CI gates **both** boundaries: every PR into `development`, and the release PR into
`main` (plus `release.yml`, which calls it).

It briefly did not. While the repo was private, Actions minutes were billed and CI
was narrowed to the release boundary only — nothing on `development`. The cost of
that was concentrated on whoever cut the release: **a red release PR indicts every
change merged since the last one**, and the recovery is `git bisect`, not a glance
at a diff. The repo went public on 2026-09-04, standard-runner minutes became free,
and the reason for the trade evaporated, so the `development` gate came back.

Worth keeping as a pattern: a constraint-driven decision should name the
constraint, so that when the constraint lifts the decision can be revisited
rather than inherited.

### The matrix

| job | where | blocking |
|---|---|---|
| `quality` | ubuntu (node 22, 24), windows (node 24) | yes |
| `test` | ubuntu × 2 nodes × 10 shards, windows × node 24 × 10 shards | yes |
| `test-macos` | macos × 4 shards, node 24 | **no — advisory** |
| `CI gate` | ubuntu | the one required check |

**Windows is blocking** because it is the platform this project is developed and
most used on, and its defects have never been theoretical: `npm.cmd` with
`shell: false` is `EINVAL` since Node's CVE-2024-27980 change, and two concurrent
`fs.rename` calls on one source **both succeed** on Windows (§148) — a broken
exclusive-claim that shipped and was caught by a human, not by CI.

**macOS is advisory on purpose.** The suite has never run there, so making it a
gate before it has ever been green would block every merge on unknown, unrelated
failures. It reports and blocks nobody, and it is deliberately not in `ci-gate`'s
`needs`. Promote it once it has been green for a few runs; if it is still red
weeks from now, that is a finding about macOS support worth a task, not a reason
to delete the job. `R1.6` and `R7.3` are both blocked for want of non-Windows
hardware — this is the first thing in the project that has any.

There is deliberately **no `push:` trigger**: `development` is only reached through
a PR that was already gated, and a push to `main` runs the release, which calls CI
itself.

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
rather than trusting the upload.

**Publishing to npm is an explicit opt-in**, not a consequence of a secret
existing. The gate is `vars.NPM_PUBLISH == 'true'` **and** a non-empty
`NPM_TOKEN`. That distinction was learned the hard way: the job originally fired
whenever the token was non-empty, treating *a secret is configured* as a proxy
for *we intend to publish*. A token was present but did not authenticate, so
v0.50.0 and v0.51.0 each produced a complete, correct release and then reported
FAILURE — and a run that is expected to be red is not a signal, it is training.
(Same predicate-as-proxy mistake R13.11 recorded for `inherit` auth.)

Setting the variable while the token is empty fails loudly rather than skipping
silently, because that combination can only mean someone meant to publish.

Not `continue-on-error`: hiding a real publish failure in the one workflow whose
job is to be trustworthy would be worse than the failure. The VS Code publish
remains gated on `VSCE_PAT` alone — it has never mis-fired.

Either way the release is complete: `golem-run-<version>.tgz` is attached to the
Release, so nothing is lost by not publishing.

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

`POST` to `PORTAL_WEBHOOK_URL`, authenticated with a **GitHub Actions OIDC
token** (since 2026-09-05 — *Authentication: OIDC, not a shared secret*, below):

| header | value |
|---|---|
| `Authorization` | `Bearer <GitHub Actions OIDC JWT>`, minted for the portal's audience |

The token's own `exp` bounds replay, so there is no signed timestamp window to
enforce and nothing on either side to rotate. Body — unchanged by the switch:

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

Three properties worth keeping, and kept when the portal side was built:

- **It runs after the release is published**, in its own job. A webhook failure
  cannot unpublish anything — it goes red, visibly, instead of the portal
  silently serving a stale schema forever.
- **It retries 5xx and gives up on 4xx.** A refused token is a bug, and retrying
  a refused token three times just makes three refused tokens.
- **It is inert until `PORTAL_WEBHOOK_URL` is set.** That is now a repository
  *variable*, not a secret: a URL is not a secret, and storing it as one makes it
  invisible in the log exactly when you want to read it.

The portal verifies the token, then fetches `config_schema.url` and checks it
against `sha256` before caching it by `version`.

### Authentication: OIDC, not a shared secret

The HMAC scheme below was replaced on 2026-09-05. It is recorded because the
receiving half's history only makes sense with it, not because either side still
speaks it: the portal answers **401** to a correctly signed HMAC request, and
asserts that in its own smoke test rather than assuming it.

The sending job asks for `id-token: write` — **on that job alone**, which is the
difference between one job being able to speak for the repository and every job
being able to — mints a token for the portal's audience, and sends it as a
bearer. What the portal checks, in order, rejecting with a reason in its log:

1. A well-formed **RS256** JWT with a `kid`, screened before any network call.
2. The signature, against GitHub's JWKS.
3. `iss` is exactly `https://token.actions.githubusercontent.com`.
4. `aud` is **exactly** the portal's audience — not a prefix match. It defaults
   to the portal's public origin (`https://golem.run`); this repo sends
   `vars.PORTAL_OIDC_AUDIENCE` when set.
5. `exp` / `nbf` / `iat`, with 60s of clock tolerance.
6. `repository` is exactly `cloudcatalyst/golem`.
7. `workflow_ref` starts with
   `cloudcatalyst/golem/.github/workflows/release.yml@`.

**Point 7 is load-bearing for anything that wants to send this webhook.** Only
the release workflow may publish a schema, so *moving or renaming `release.yml`
turns every push into a 401* until the portal's `GOLEM_OIDC_WORKFLOW` is told —
and a webhook sent from a workflow file of its own would mint a token naming
*that* file and be refused. That is why the manual re-push is a **`notify_only`
mode of `release.yml`** rather than the separate small workflow it would
otherwise obviously be: dispatch Release with `notify_only` ticked and it skips
ci/binaries/assets/release, sending the webhook for a tag that is already
published, against the assets that tag already has. The job decodes its own
token's `aud` and `workflow_ref` and fails on them locally, so the two things
that actually go wrong say so in this repo's log instead of arriving as an
opaque 401 legible only in the portal's.

### The receiving half (built 2026-09-04)

Pre-OIDC history: the signature row below describes the HMAC scheme both sides
spoke until 2026-09-05. The body and document rows still hold — the switch
changed authentication and nothing downstream of it.

`POST /api/webhooks/golem-build` in the portal repo. It was already written
before this contract existed, against an **earlier and incompatible** design —
so "both halves exist" was not the same as "the loop is closed". Three
mismatches, each of which would have failed the first release cut with the
secrets set:

| | this repo sends | the portal expected | result |
|---|---|---|---|
| signature | `sha256=<hex>` over `"<ts>.<body>"`, with `x-golem-timestamp` | bare `<hex>` over the body, no timestamp | 400 |
| body | an envelope naming `config_schema: {url, sha256}` | the schema **inline**, as `{version, schema}` | 422 |
| document | `{version, groups[].controls[].id/kind}` | `{version, sections[].settings[].key/type}` | 422 |

The third was the expensive one: it also broke the **GitHub fallback**, so the
portal's Settings page would have stayed read-only even with the webhook
switched off entirely. A contract that only one side has ever executed is
untested by construction, and the third mismatch shows the cost is not confined
to the path the contract describes.

Resolved on the portal side, because the direction of truth says so — this repo
owns the contract, the portal owns its implementation (see
[[Portal Install Contract]]), and the sender had already shipped.

Two details worth knowing before editing either half:

- **The 4xx/5xx split is an instruction to the sender.** 4xx means retrying
  cannot fix it (bad signature, stale timestamp, a document that will never
  parse); 5xx means try again (the asset is not readable yet, the database
  blipped). A release asset can take a moment to become readable, so an
  unfetchable `config_schema.url` is deliberately a 502, not a 422.
- **The portal parses leniently and refuses a header.** It is strict only about
  `id`, `family` and `kind`, so a future release that adds a widget kind cannot
  make every team's Settings page read-only; and it refuses a document carrying
  the machine-specific `header` block, which is the same thing this workflow
  asserts on the way out.

### Proven live, and what is actually left (2026-09-05)

The loop **ran**, in v0.52.1, against a portal on `localhost:3000` behind an
ngrok tunnel — the first time either half executed against the other:

```
attempt 1 → HTTP 200
{"version":"0.52.1","stored":true,"replaced":false}
```

What is left is neither code nor a secret: **`golem.run` has no A record yet**.
Once it resolves and the portal is deployed there, one repository **variable** —
`PORTAL_WEBHOOK_URL` = `https://golem.run/api/webhooks/golem-build` — closes it,
and `notify_only` re-pushes the latest tag without cutting a release. It is left
unset until then, which is what keeps the job inert rather than red on every
release.

**To test against a local portal**, point `PORTAL_WEBHOOK_URL` at a tunnel and
leave the audience at production. The portal pins `GOLEM_OIDC_AUDIENCE`
separately from `NEXT_PUBLIC_APP_URL` on purpose, so that tunnelling the webhook
does not also move its Stripe and Nango callbacks. **A tunnel moves the address,
not the identity** — the audience is an opaque string and never has to resolve.
Setting it to `http://localhost:3000` is what earned
`401 audience must be exactly https://golem.run` on the v0.52.1 release.

See `portal-release-webhook`, and verification-notes §154/§155.

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
