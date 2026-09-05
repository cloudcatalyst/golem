---
task: portal-release-webhook
title: "The portal end of the release webhook — OIDC on both sides; now needs one repo variable and a release"
state: queued
owner: user
size: S
discipline: code
design: "BOTH ends are now built to the same contract, re-authenticated to GitHub Actions OIDC on 2026-09-05 (portal deployed OIDC-only; the sender followed — `docs/plan/verification-notes.md` §154). Sender: `.github/workflows/release.yml` job `notify-portal`. Receiver: the portal's `app/api/webhooks/golem-build/route.ts`, which was already written against an EARLIER, incompatible design and was corrected — three mismatches, one of which also broke the GitHub fallback. Wire contract: `docs/wiki/concepts/Release Pipeline.md` § The portal webhook (+ § The receiving half). Findings: `docs/plan/verification-notes.md` §153."
gate: "MET against a local portal 2026-09-05 (v0.52.1, `stored:true`; unauthenticated and malformed-bearer POSTs both refused 401). Re-confirm against production once `golem.run` resolves: a release publishes → the portal has the new `config-schema.json` cached under its version WITHOUT anyone poking it."
blocked: "**`golem.run` has no A record** (observed 2026-09-05: `curl: (6) Could not resolve host`). The code is done on both sides and the loop was RUN end to end against a local portal behind a tunnel — `HTTP 200 {\"version\":\"0.52.1\",\"stored\":true}`. What remains is DNS + a portal deploy, then set `vars.PORTAL_WEBHOOK_URL` (left unset on purpose: it is what keeps the job inert instead of red every release)."
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
>
> **Run end to end 2026-09-05**, shipped in v0.52.1 and proven against a portal
> on `localhost:3000` behind an ngrok tunnel — the first time either half had
> executed against the other. `golem.run` turned out not to resolve yet, so the
> remaining blocker is DNS and a deploy, not code and not a credential.
> Details: §155. Debrief:
> `docs/wiki/debriefs/2026-09-05-portal-release-webhook-oidc.md`.

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

1. **Make `golem.run` resolve** and deploy the portal there. This is the whole
   remaining blocker — see `R7.6-infra`.
2. Set **`vars.PORTAL_WEBHOOK_URL`** (a repository *variable*: Settings →
   Secrets and variables → Actions → **Variables**) to
   `https://golem.run/api/webhooks/golem-build`. Leave `PORTAL_OIDC_AUDIENCE`
   unset — the workflow already defaults to `https://golem.run`, which is what
   the portal pins regardless of the URL it is reached by.
3. Dispatch **Release → `notify_only`** against the latest tag and confirm
   `{"version":"…","stored":true}` (a repeat answers
   `{"stored":false,"reason":"unchanged"}`, also success). No release needs
   cutting to test it.

There is nothing to delete: this repo has **no** Actions secrets and no other
variables. All three steps are `owner: user`; the portal side is already
deployed OIDC-only, so nothing in that repo is waiting on review.

### What testing against a LOCAL portal takes

Proven 2026-09-05, and worth writing down because the obvious guess is wrong:
point `vars.PORTAL_WEBHOOK_URL` at an ngrok tunnel to `localhost:3000` and leave
the **audience at production**. The portal sets `GOLEM_OIDC_AUDIENCE`
independently of `NEXT_PUBLIC_APP_URL` precisely so a tunnel does not move Stripe
and Nango callbacks with it. The audience is an opaque string; it never has to
resolve. Setting it to `http://localhost:3000` is what produced
`401 audience must be exactly https://golem.run` on the v0.52.1 release.

## Failure behaviour on this side

The sender's job goes red on failure but the release stays published. So a
missed webhook degrades to *the portal is serving a stale schema* — recoverable,
visible in Actions, and re-runnable via the Release workflow's
`workflow_dispatch` with `notify_only`, which re-sends the webhook for an
already-published tag without rebuilding a byte. It must never be able to
unpublish or block a release.
