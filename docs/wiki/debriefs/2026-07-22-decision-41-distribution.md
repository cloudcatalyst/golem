---
title: 2026-07-22 — Decision 41 distribution, versioning & self-update (R7)
type: debrief
tags: [distribution, versioning, install, self-update, release, r7]
sources: [docs/golem-spec.md, docs/plan/verification-notes.md, install/install.sh, install/install.ps1, deploy/nginx/golem-run.conf, src/update/index.ts]
created: 2026-07-22
updated: 2026-07-22
---

# Decision 41 — distribution, versioning & self-update (R7)

Shipped the golem.run onboarding one-liner + how installs stay current. Spec
Decision 41 (v1.22, USER DECISION); ROADMAP R7. Facts verified first in
verification-notes §70. Related: [[Dogfooding Golem]], [[Guidance Rules]].

## What shipped

- **One version, everywhere (41a).** `package.json` is canonical;
  `scripts/sync-version.mjs` generates `src/version.ts` (was a hardcoded literal
  in `src/index.ts`) and is wired into `npm run build`. `scripts/release.mjs`
  bumps both package.json files in lockstep, regenerates the constant, and prints
  the (manual, credentialed) publish steps — see `RELEASING.md`.
- **Tiered installer, npm-first (41b).** `install/install.sh` (POSIX) +
  `install/install.ps1` run the same ladder: Node ≥22+npm → `npm i -g golem-run`;
  else a Bun-compiled standalone binary (no Node); else (opt-in
  `GOLEM_INSTALL_NODE=1`) bootstrap Node then retry. Both handle the
  not-yet-published case gracefully.
- **golem.run content negotiation (41c).** `deploy/nginx/golem-run.conf` — a
  `map $http_user_agent` serves install.ps1 to PowerShell, install.sh to
  curl/wget, and `landing.html` to browsers, off the bare domain. PowerShell is
  matched before the generic browser rule (its UA also contains "Mozilla").
- **Standalone binary channel (41d).** `scripts/build-binary.mjs` cross-compiles
  per-OS/arch via `bun build --compile`. Build-wired only — **not run locally**
  (no Bun/mac/linux in-session); belongs in a CI release workflow.
- **Self-update (41e).** New `src/update/` module: `detectInstallMethod`
  (bun→binary, node_modules→npm), `checkForUpdate` (24h-cached registry query,
  404/offline-tolerant, never throws), `semverGt`. `golem update [--check]
  [--json] [--force]` upgrades (npm) or prints the command (binary). The cached
  verdict surfaces in `golem status`, the terminal statusline (`⇧ update`), and
  the VS Code extension (status-bar `$(arrow-up)` badge + `golem.update` command
  running the upgrade in an integrated terminal, polled on a 6h cadence).

## Design calls worth remembering

- **Hot paths never hit the network.** The status line and VS Code poll read only
  the cached `update-check.json`; the network is touched only by an explicit
  `golem update --check` (or when the 24h cache is stale). The check is always
  recomputed against the *running* `VERSION`, so a cached "latest" stays correct
  after a manual upgrade.
- **Publishing is deferred to the user.** `golem-run` and `golem-vscode` are both
  unpublished (npm 404 as of today). All machinery + `RELEASING.md` are in place,
  but `npm publish` / Marketplace publish / tag-push are outward, credentialed
  acts left for the user to trigger. The install + update paths fail gracefully
  until then.
- **The binary carries Bun, not Node.** `bun build --compile` bakes in the Bun
  runtime; behaviour parity must be covered by an e2e smoke, not assumed. The
  optional `web-tree-sitter` WASM isn't embedded, so the binary degrades to the
  default (non-syntax-aware) chunker.

## Verification

`tsc --noEmit`, Biome lint + format, and `vitest run` (1145 tests, incl. 14 new
`tests/unit/update/`) all green; VS Code `node --test` 19 green. `npm run build`
green with the new sync-version step. `golem update --check` smoke-tested against
the unpublished package — returns the graceful "not published yet" path.

## Open follow-ups

- Run `scripts/build-binary.mjs` in CI and smoke-test the actual binaries per OS
  (the standalone tier is unverified — verification-notes §70).
- First `npm publish` + Marketplace publish + `v0.1.0` tag (ROADMAP R7.5, USER).
- Stand up the nginx host and confirm the UA `map` serves each client correctly.
