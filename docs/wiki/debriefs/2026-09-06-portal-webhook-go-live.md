---
title: The Portal Webhook's Last Gap Was Two Repository Variables
type: debrief
tags: [ci, release, github-actions, portal, oidc, webhook, config, dns]
sources: [.github/workflows/release.yml, docs/wiki/concepts/Release Pipeline.md, docs/plan/tasks/portal-release-webhook.md, docs/plan/verification-notes.md]
created: 2026-09-06
updated: 2026-09-06
---

# The portal webhook's last gap was two repository variables

`golem.run` resolves now (`216.198.79.1`) and the portal is deployed there, with
Stripe, Nango and Clerk webhooks all reaching it and schema `0.52.1` served from
its stored table — the very document the localhost/ngrok run of 2026-09-05
pushed. So the release webhook was the only leg of the portal that had never run
against production, and the only one that needs a release from this repo to
exercise.

Closing it took **no code at all**.

Pages touched: [[Release Pipeline]] (§ What the portal answers — new; § Deployed
at the address it will actually run at — new; § Repository settings) ·
[[Portal Install Contract]] (unchanged, still the direction-of-truth).

## What actually changed

Two repository **variables**, set with `gh variable set`:

```
PORTAL_WEBHOOK_URL   = https://golem.run/api/webhooks/golem-build   (42 bytes)
PORTAL_OIDC_AUDIENCE = https://golem.run                            (17 bytes)
```

Variables, not secrets — neither is one, and storing a URL as a secret makes it
invisible in the log exactly when you want to read it. `PORTAL_WEBHOOK_URL` had
been left unset **on purpose**: an unset URL skips `notify-portal` cleanly and
the release stays green, whereas a wrong one turns every release amber for no
benefit. It only became correct to set it once there was something at the other
end.

The byte counts are the check worth keeping. The portal compares the audience
**exactly** against `GOLEM_OIDC_AUDIENCE ?? NEXT_PUBLIC_APP_URL`, so a trailing
slash or a `www.` is the whole failure — and `gh variable list` renders values in
a way that would hide one. `gh api repos/…/actions/variables` with a `|length`
in the jq does not.

## The sender already matched, check for check

Audited `notify-portal` against every verification the portal performs. It
needed nothing:

| the portal checks | the job already does |
|---|---|
| `permissions: id-token: write` | on that job alone — the difference between one job speaking for the repository and every job doing so |
| `Authorization: Bearer <OIDC token>` | yes; no HMAC header remains to send |
| `aud` exactly `https://golem.run` | `vars.PORTAL_OIDC_AUDIENCE`, defaulting to that literal, asserted locally *before* the POST |
| `repository == cloudcatalyst/golem` | `$GITHUB_REPOSITORY`, by construction |
| `workflow_ref` == `.github/workflows/release.yml` | asserted locally — and the re-push is a `notify_only` mode of this file for precisely this reason |
| a release-asset `config_schema.url` | `releases/download/<tag>/config-schema.json`, with a sha256 the portal re-checks before trusting a byte |
| a document with no `header` block | `config schema --json --no-header`, with a header-leak assertion in the `assets` job |
| retry 5xx, give up on 4xx | yes |

## The lesson

**A contract can fail two ways, and they look nothing alike.** §153 was the
first: both halves built, three code-level mismatches, nothing connected. This
was the second: both halves correct and nothing pointed at anything. The first
is found by reading two implementations side by side; the second is invisible to
that exercise entirely, because every line of both halves is right.

So "both halves speak the contract" and "the loop is closed" stay separate
claims, and the second one needs configuration named and checked, not inferred
from the first.

## One divergence, deliberately left as two

The live 200 body was `{"version":"0.52.1","stored":true,"replaced":false}` —
`replaced` — whereas the portal's own account of the contract names
`reason: "unchanged"` on the `stored: false` path. Both are 200 and the job reads
neither field (it tests the status class), so nothing behaves differently. Rather
than pick one as canonical, [[Release Pipeline]] § What the portal answers now
records both shapes, and the question went back to the portal side. This repo
owns the wire contract, so if it should say one thing, it gets said here first.

## Where it stands

Unblocked, not done. The gate on `portal-release-webhook` is "a release
publishes and the portal has the new `config-schema.json` cached under its
version without anyone poking it", and only a release can meet it — the merge
into `main` IS the release, so cutting one is the test. Read the `OIDC claims:`
line in the job log for the `aud` it minted; the portal side logs
`authenticated by OIDC` then `stored schema`. Details: §156.
