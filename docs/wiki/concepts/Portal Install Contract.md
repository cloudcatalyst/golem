---
title: Portal Install Contract
type: concept
tags: [distribution, install, portal, vercel, golem.run, alignment]
sources: [install/install.sh, install/install.ps1, docs/plan/verification-notes.md#149, docs/plan/verification-notes.md#153, docs/plan/tasks/R7.6-infra.md, docs/plan/tasks/release-portal-assets.md]
created: 2026-09-04
updated: 2026-09-04
---

# Portal Install Contract

What `golem.run` must DO for the shipped installers to work — stated as
behaviour, so it survives a change of hosting tooling. It already has: the
portal is a Next.js app on Vercel, and the routing this page describes moved out
of nginx into `next.config.ts` `redirects()` without any of the behaviour
changing.

This page is the thing both repos read. The nginx reference config that used to
sit beside it was **removed on 2026-09-04** — it described a box that does not
exist, and a second dialect of these rules is a second place for them to drift.
It is in git history if the User-Agent matching is ever wanted in that form
again.

Related pages: [[Team Layer]] · [[Architecture]] · [[Dogfooding Golem]].

---

## Direction of truth

| owned by this repo | owned by the portal |
|---|---|
| the bytes of `install/install.sh` and `install/install.ps1` | how the routes below are implemented |
| binary asset naming, the installer ladder, the env-var names | DNS, TLS, domains, the browser-branch site |
| the route contract on this page | caching, status codes, headers |

The portal must **serve this repo's installer files, not a fork of them.** It
does this by redirecting to GitHub release assets, which is why
`release-portal-assets` exists: nothing on the portal side can work until the
release actually carries them.

## The routes

### 1. Bare domain content-negotiates on User-Agent

`GET https://golem.run/` returns a different body per client (spec Decision 41c):

| User-Agent | body |
|---|---|
| PowerShell (`irm`, `iwr`) | `install.ps1` |
| `curl`, `wget`, `httpie`, generic fetchers | `install.sh` |
| anything else | the landing / docs page |

**PowerShell must be tested BEFORE the browser fall-through**, because its UA
also contains `Mozilla` — get that order wrong and `iex` swallows an HTML page.

**And on Windows, `curl` is an alias for `Invoke-WebRequest`**, so a Windows user
typing either verb must get the PowerShell installer. Matching only the literal
`curl` token hands them a shell script they cannot run. This is the subtlest
requirement on the page and the one `R7.6-infra` most needs to confirm live.

The two one-liners that must work:

```
curl -fsSL https://golem.run | sh
irm https://golem.run | iex
```

### 2. Explicit paths always work

Unambiguous fallbacks for when UA matching misfires, and what the docs cite:
`/install.sh` and `/install.ps1`.

### 3. `/bin/<asset>` resolves to a standalone binary

Both installers default `GOLEM_INSTALL_BASE` to `https://golem.run` and fetch
`$base/bin/$asset` (`install/install.sh:66`, `install/install.ps1:55-56`):

- POSIX: `golem-${os}-${arch}` — os/arch from `uname`
- Windows: `golem-windows-$arch.exe`

The asset name must be **constrained** to `golem-…` at the redirect. An
unconstrained parameter turns the path into an open redirect into any file of
any release.

## The installer ladder (do not reorder)

1. Node ≥ 22 + npm present → `npm install -g golem-run` (self-updating)
2. otherwise → download the standalone binary (no Node)

`GOLEM_VERSION` pins the npm version; `GOLEM_INSTALL_BASE` overrides the base
URL. Both are read by both scripts and are part of the contract.

## What the move off nginx cost

Nothing in behaviour. Three things in implementation, all worth knowing before
editing the rules (recorded in verification-notes §149 item 1):

- **Vercel compiles `has` header values as `^value$`, case-SENSITIVELY**, with no
  way to pass an `i` flag — `(?i)` is not JavaScript. Character-class patterns
  are required. nginx's `~*` gave this away free.
- **307, not 308.** The right answer for `/` depends on who is asking, so it must
  never be cached as the answer for everyone.
- **No files are served from a box any more.** Everything is a redirect to a
  release asset, which moves the failure mode from "wrong file" to "404 because
  the release does not carry it".

## The prerequisite

Because `/install.sh`, `/install.ps1` and `/bin/<asset>` all point at
`releases/latest/download/…`, the release has to carry the install scripts as
well as the six binaries.

It did not, until 2026-09-04: the workflow uploaded `dist-bin/*` and nothing
else, so both script paths would have 404'd. `release-portal-assets` fixed that —
the release now stages the scripts, packs the npm tarball, renders
`config-schema.json`, and **asserts each required asset is present** rather than
trusting the upload.

So what stands between the portal and a working front door is now only that **no
release has been cut since**. Actions itself is healthy: the 2026-08-22 billing
block cleared by 2026-09-02. See [[Release Pipeline]].

## The live gate

`R7.6-infra` closes on checks against the deployed app, not against a config
file: curl, PowerShell, a Windows `curl`, and a browser each get the right thing
from `https://golem.run`. Outward and credentialed — `owner: user`.
