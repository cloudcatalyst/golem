---
task: portal-release-webhook
title: "The portal end of the release webhook — OIDC on both sides; now needs one repo variable and a release"
state: queued
owner: user
size: S
discipline: code
design: "BOTH ends are now built to the same contract, re-authenticated to GitHub Actions OIDC on 2026-09-05 (portal deployed OIDC-only; the sender followed — `docs/plan/verification-notes.md` §154). Sender: `.github/workflows/release.yml` job `notify-portal`. Receiver: the portal's `app/api/webhooks/golem-build/route.ts`, which was already written against an EARLIER, incompatible design and was corrected — three mismatches, one of which also broke the GitHub fallback. Wire contract: `docs/wiki/concepts/Release Pipeline.md` § The portal webhook (+ § The receiving half). Findings: `docs/plan/verification-notes.md` §153."
gate: "A release publishes → the portal has the new `config-schema.json` cached under its version WITHOUT anyone poking it, and a POST carrying no token, an expired one, or one minted for another audience or workflow is refused."
blocked: "the CODE is done on both sides. What remains is one repository VARIABLE: `vars.PORTAL_WEBHOOK_URL` = the portal's `/api/webhooks/golem-build`. No shared secret exists any more — OIDC removed it. Then cut a release (or dispatch Release with `notify_only`)."
depends_on: [release-portal-assets]
touches: []
created: 2026-09-04
updated: 2026-09-05
---

> **Re-scoped 2026-09-04.** The receiving half turned out to be already written
> — and written against an earlier, incompatible design, so *both* halves
> existed and the loop still did not connect. It has been corrected to the
> contract below on a branch in the portal repo
> (`golem-release-schema-loop`): `tsc --noEmit` and `next build` both green.
> What is left is credentialed, not code. The three mismatches and why the
> portal was the side that changed: `docs/plan/verification-notes.md` §153.
>
> **Re-authenticated 2026-09-05.** The portal shipped OIDC-only and removed the
> shared secret, so this repo's sender was switched to a GitHub Actions OIDC
> bearer token before the next release could 401 on it. Details: §154.

## Why it is tracked in this repo

The sending half is here. This document exists so the receiving half is not
forgotten — the same reason `R7.6-infra` tracks an act that happens on someone's
DNS panel.

## What the harness sends

`POST` to `PORTAL_WEBHOOK_URL`, after the release is published, from its own job.

| header | value |
|---|---|
| `Authorization` | `Bearer <GitHub Actions OIDC JWT>`, minted for the portal's audience |

**Re-authenticated 2026-09-05.** The shared HMAC secret is gone, not deprecated
— a correctly signed HMAC request is a 401. The job asks for `id-token: write`
(on that job only), mints a token for `vars.PORTAL_OIDC_AUDIENCE` (default
`https://golem.run`) and sends it as a bearer. The token's `exp` bounds replay,
so `x-golem-timestamp` had nothing left to enforce and went with it.

The portal also requires `repository` = `cloudcatalyst/golem` and `workflow_ref`
starting `cloudcatalyst/golem/.github/workflows/release.yml@`. That last one is
why the manual re-push is a `notify_only` mode of `release.yml` and not a
workflow of its own: a second file would mint a token naming itself and be
refused. Move or rename `release.yml` and the portal's `GOLEM_OIDC_WORKFLOW`
must be told, or every push is a 401.

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

## What the portal has to do

All five are implemented. Kept as the checklist the receiver is judged against.

1. **Verify the OIDC token before anything else** — shape (`RS256` + `kid`)
   screened before any network call, then the signature against GitHub's JWKS,
   then `iss`, then `aud` **exactly** (not a prefix), then `exp`/`nbf`/`iat`
   with 60s tolerance, then `repository` and `workflow_ref`.
2. **Nothing to do about replay.** The token's own `exp` bounds it; there is no
   timestamp window left to enforce.
3. **Fetch `config_schema.url` and check it against `sha256`** before trusting
   it. The webhook says a schema exists; it is not itself the schema.
4. **Cache it by `version`**, which is what makes the Settings page stop being
   read-only.
5. **Answer 2xx once durably stored**, 4xx for a refused token. The sender
   retries 5xx and gives up on 4xx — so a 4xx must mean "do not retry, this is
   broken", not "busy".

## What closing it actually needs now

1. Set **`vars.PORTAL_WEBHOOK_URL`** (a repository *variable*, Settings →
   Secrets and variables → Actions → Variables) to the portal's
   `/api/webhooks/golem-build`. Set `vars.PORTAL_OIDC_AUDIENCE` only if the
   portal's audience is not `https://golem.run`.
2. Delete the now-dead **`PORTAL_WEBHOOK_SECRET`** secret, and
   `PORTAL_WEBHOOK_URL` if it is still sitting there as a secret.
3. Cut a release — or dispatch Release with `notify_only` against an existing
   tag — then confirm the portal answers `{"version":"…","stored":true}` (a
   re-run answers `{"stored":false,"reason":"unchanged"}`, also success) and has
   that `config-schema.json` cached under its version.

All three are `owner: user`. The portal side is already deployed OIDC-only, so
there is no longer a branch in that repo waiting on review.

## Failure behaviour on this side

The sender's job goes red on failure but the release stays published. So a
missed webhook degrades to *the portal is serving a stale schema* — recoverable,
visible in Actions, and re-runnable via the Release workflow's
`workflow_dispatch` with `notify_only`, which re-sends the webhook for an
already-published tag without rebuilding a byte. It must never be able to
unpublish or block a release.
