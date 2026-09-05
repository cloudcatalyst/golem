---
title: The Portal Webhook Went OIDC-Only — And The Loop Finally Ran End To End
type: debrief
tags: [ci, release, github-actions, portal, oidc, webhook, auth, dns]
sources: [.github/workflows/release.yml, docs/wiki/concepts/Release Pipeline.md, docs/plan/tasks/portal-release-webhook.md, docs/plan/verification-notes.md]
created: 2026-09-05
updated: 2026-09-05
---

# The portal webhook went OIDC-only — and the loop finally ran end to end

The portal shipped `POST /api/webhooks/golem-build` as **OIDC-only** and removed
the shared secret outright: a correctly signed HMAC request is now a 401, and the
portal's own smoke test asserts that rather than assuming it. This repo owns the
sending half, so it had to follow before the next release 401'd on it.

It did, in **v0.52.1**, and then the loop was run against a real portal for the
first time — which is the part [[Release Pipeline]] and verification-notes §153
had been unable to claim.

Pages touched: [[Release Pipeline]] (§ The portal webhook, rewritten) ·
[[Portal Install Contract]] (unchanged, still the direction-of-truth).

## What shipped

`notify-portal` asks for `id-token: write` **on that job alone**, mints a token
for the portal's audience, and sends it as `Authorization: Bearer`. Deleted with
it: `PORTAL_WEBHOOK_SECRET` and its guard, the `openssl dgst` line, `$SIG`,
`$TIMESTAMP`, and both `x-golem-*` headers — the token's own `exp` bounds replay,
so the signed-timestamp window had nothing left to enforce. `PORTAL_WEBHOOK_URL`
moved from a secret to a repository **variable**; a URL is not a secret, and
storing it as one makes it invisible in the log exactly when you want to read it.

The body, the asset URLs, the `config_schema.url` + `sha256` pair and the 4xx/5xx
split did not move.

## The lesson worth carrying: the identity is the file path

The brief proposed a small `notify-portal.yml` with `workflow_dispatch`, so a
lost webhook could be re-pushed without cutting a release. **It cannot work**,
and the reason is the portal's own check 7: `workflow_ref` names the workflow
file the run *entered through*, so a second file mints a token naming **itself**
and is refused with the same 401 the helper was meant to avoid. Reusable-workflow
indirection does not rescue it either — the caller is what `workflow_ref` reports.

That is the generalisable shape: **OIDC moves trust from a value both sides hold
to a claim about which workflow file ran, so "add a small helper workflow" stops
being a free refactor and becomes a contract change.** A shared secret does not
care which file sends the request. A `workflow_ref` check is precisely a statement
about the file.

So the re-push shipped as a `notify_only` **input on `release.yml`** — skipping
`ci`/`binaries`/`assets`/`release`, pulling `config-schema.json` from the tag's
already-published assets with `gh release download` rather than rebuilding it,
because a rebuild would compute a `sha256` for bytes the portal is not going to
fetch. It was used in anger within the hour.

## Three things the live run taught that no amount of reading would have

1. **The audience is pinned separately from the app URL, on purpose.** The first
   real release 401'd: `audience must be exactly https://golem.run`. The portal
   sets `GOLEM_OIDC_AUDIENCE` independently of `NEXT_PUBLIC_APP_URL` *precisely
   so that tunnelling the webhook does not also move Stripe return URLs and Nango
   callbacks*. The sender must therefore keep sending the production audience
   even when the URL points at a tunnel — the audience is an opaque string and
   never needs to resolve.
2. **`golem.run` has no A record yet.** Pointing the variable at production made
   three attempts fail with `Could not resolve host`. The variable was left
   **unset**, which is what makes the job inert by design — a permanently red
   release job is the "check nobody reads" failure `ci.yml` already carries a
   comment about.
3. **A bot-opened release PR stalls at `action_required`.** The Prepare release
   workflow opens the PR as `github-actions[bot]`, and its CI run needs a human
   (or `POST /actions/runs/<id>/approve`) before anything executes. Worth knowing
   before concluding CI is broken.

## Verified, not assumed

Against a local portal through an ngrok tunnel, from the real release workflow:

```
OIDC claims: {"aud":"https://golem.run","repository":"cloudcatalyst/golem",
              "workflow_ref":"cloudcatalyst/golem/.github/workflows/release.yml@refs/tags/v0.52.1",
              "exp":1788577435}
attempt 1 → HTTP 200
Portal notified: v0.52.1 (schema sha256 389edf91a49b…)
{"version":"0.52.1","stored":true,"replaced":false}
```

Note the `workflow_ref` from a **tag** dispatch — `@refs/tags/v0.52.1`. The
portal's prefix check is on everything before the `@`, so it holds across branch
and tag refs alike, which is what makes `notify_only` usable against any
published tag.

Before that, the guard itself was exercised with synthetic tokens: a
`release.yml@…` ref accepts, a `notify-portal.yml@…` ref rejects, and an `aud` of
`https://golem.run/api` rejects against `https://golem.run` — which is what
"exact, not a prefix" costs anyone who assumes otherwise.

## A small defect the failure exposed

`curl -w '%{http_code}' … || echo 000` prints **two** codes when curl never got a
response, because `-w` already emits `000` — the log read `HTTP 000000`, and a
two-line value is not an integer, so the 4xx/5xx comparisons silently failed
instead of saying so. Now normalised to three digits before use. It had been
there since the job was written, and only a host that does not resolve was ever
going to show it.

## Where it stands

Code: done, both halves, proven against a running portal. What remains is
neither code nor a secret — `golem.run` needs to resolve, and then one repository
variable. See `portal-release-webhook`, and §154/§155 in the verification notes.
