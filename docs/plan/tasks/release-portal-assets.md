---
task: release-portal-assets
title: "The release must carry install.sh, install.ps1 and config-schema.json — every portal path redirects to assets that do not exist"
state: done
owner: agent
size: S
discipline: code
design: "The portal repo's `docs/deploy.md` (\"Prerequisite in the harness repo\") and `docs/team-config.md` §2; measured against `.github/workflows/release.yml` in `docs/plan/verification-notes.md` §149 item 2. The pipeline it now lives in: `docs/wiki/concepts/Release Pipeline.md`."
gate: "A release built from this workflow carries, at `releases/latest/download/`: `install.sh`, `install.ps1`, `config-schema.json`, the npm tarball, and all six binaries. `config-schema.json` contains no `header` and no control whose layer is anything but `default`/`runtime`."
blocked: "CLEARED 2026-09-06 — PROVEN by v0.53.0."
depends_on: []
touches: [.github/workflows/release.yml, src/cli/commands/config.ts]
created: 2026-09-04
updated: 2026-09-04
---

> **Implementation landed 2026-09-04**, as part of restructuring the release
> around merge-to-main. What remains is the live proof, which needs Actions to
> run. Read `docs/wiki/concepts/Release Pipeline.md` for the whole pipeline; this
> document is now just the asset gate.

## What the gap was

`.github/workflows/release.yml` uploaded `dist-bin/*` and nothing else, while the
portal redirects **every** install path to `releases/latest/download/…`:

| portal path | needs asset |
|---|---|
| `/` (curl/wget/httpie UA) | `install.sh` |
| `/` (PowerShell UA) | `install.ps1` |
| `/install.sh`, `/install.ps1` | the same two |
| `/bin/<asset>` | `golem-<os>-<arch>[.exe]` |
| portal Settings page | `config-schema.json` |

Binaries were attached; the two install scripts were not, so the one-liner on the
front page would 404.

## What landed

- The `assets` job stages `install/install.sh` and `install/install.ps1` verbatim
  — the portal serves this repo's bytes, never a fork.
- `npm pack` attaches the tarball, so the package is proven to pack on every
  release and there is an install path before npm publish is switched on.
- `config-schema.json` is rendered from `golem config schema --json --no-header`
  with **both** `--dir` and `HOME` at an empty temp dir. `--no-header` is new
  (`src/cli/commands/config.ts`): the interactive output carries absolute paths,
  the proxy port and the upstream account, none of which may travel in an
  artifact every consumer downloads. Covered by
  `tests/unit/config-schema-asset.test.ts`.
- The release job **asserts** each required asset exists after upload, rather
  than trusting it. A missing asset fails the release instead of quietly
  producing a 404 on the front door.

## What is left

Cut a release. The gate above is judged against a real one, and nothing now
prevents that: the billing block that stopped Actions between 2026-08-22 and
2026-09-02 has cleared, and `CI gate` reports normally again.

Until a release IS cut, the front door still 404s — the assets exist in the
workflow, not on a release. That is now one merge away rather than a payment
away.

## PROVEN 2026-09-06 by v0.53.0

The gate needed a release, not a code change, and v0.53.0 supplied it. The
`release` job's own "Confirm every asset golem.run redirects to is present" step
passed, and `gh release view v0.53.0` lists all seventeen assets:

```
config-schema.json  install.ps1  install.sh  golem-run-0.53.0.tgz  SHA256SUMS
golem-{darwin,linux}-{x64,arm64}  golem-windows-{x64,arm64}.exe  (+ .map each)
```

Checked independently rather than inferred from a green job:

- `https://golem.run/install.sh` and `/install.ps1` answer **307** to
  `releases/latest/download/…`
- the published `config-schema.json` is `version 0.53.0`, 14 groups, **no
  `header` block**, and hashes to
  `358aea61a4281b089f0c4444618aca78ff70321594a7328ac08d70c6a587aee0` — the same
  digest the portal webhook carried, so the portal fetched exactly those bytes

"An unrun workflow is not a passed one" was the right call to leave this open.
It has now been run.
