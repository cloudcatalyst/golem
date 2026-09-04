---
task: portal-release-webhook
title: "The portal end of the release webhook — built; now needs the two secrets and a release"
state: queued
owner: user
size: S
discipline: code
design: "BOTH ends are now built to the same contract (2026-09-04). Sender: `.github/workflows/release.yml` job `notify-portal`. Receiver: the portal's `app/api/webhooks/golem-build/route.ts`, which was already written against an EARLIER, incompatible design and was corrected — three mismatches, one of which also broke the GitHub fallback. Wire contract: `docs/wiki/concepts/Release Pipeline.md` § The portal webhook (+ § The receiving half). Findings: `docs/plan/verification-notes.md` §153."
gate: "A release publishes → the portal has the new `config-schema.json` cached under its version WITHOUT anyone poking it, and a POST with a tampered body or a stale timestamp is refused."
blocked: "the CODE is done on both sides. What remains is credentialed only: set `PORTAL_WEBHOOK_URL` (the portal's `/api/webhooks/golem-build`) and `PORTAL_WEBHOOK_SECRET` (matching the portal's `GOLEM_BUILD_WEBHOOK_SECRET`) in this repo's Actions secrets, then cut a release. The portal-side change also needs reviewing and merging in that repo."
depends_on: [release-portal-assets]
touches: []
created: 2026-09-04
updated: 2026-09-04
---

> **Re-scoped 2026-09-04.** The receiving half turned out to be already written
> — and written against an earlier, incompatible design, so *both* halves
> existed and the loop still did not connect. It has been corrected to the
> contract below on a branch in the portal repo
> (`golem-release-schema-loop`): `tsc --noEmit` and `next build` both green.
> What is left is credentialed, not code. The three mismatches and why the
> portal was the side that changed: `docs/plan/verification-notes.md` §153.

## Why it is tracked in this repo

The sending half is here. This document exists so the receiving half is not
forgotten — the same reason `R7.6-infra` tracks an act that happens on someone's
DNS panel.

## What the harness sends

`POST` to `PORTAL_WEBHOOK_URL`, after the release is published, from its own job.

| header | value |
|---|---|
| `x-golem-timestamp` | unix seconds |
| `x-golem-signature` | `sha256=<hex>` of `HMAC-SHA256(secret, "<timestamp>.<raw body>")` |

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

1. **Verify the signature over the RAW body**, before parsing it. Next.js route
   handlers must read the raw text — a re-serialized body will not match, which
   is the same trap the Stripe and Clerk handlers already navigate.
2. **Reject a stale timestamp** (a few minutes' tolerance). The timestamp is
   inside the signed material precisely so a captured POST cannot be replayed.
3. **Fetch `config_schema.url` and check it against `sha256`** before trusting
   it. The webhook says a schema exists; it is not itself the schema.
4. **Cache it by `version`**, which is what makes the Settings page stop being
   read-only.
5. **Answer 2xx once durably stored**, 4xx for a bad signature. The sender
   retries 5xx and gives up on 4xx — so a 4xx must mean "do not retry, this is
   broken", not "busy".

## What closing it actually needs now

1. Review and merge the portal branch `golem-release-schema-loop`.
2. Set `PORTAL_WEBHOOK_URL` to the portal's `/api/webhooks/golem-build`, and
   `PORTAL_WEBHOOK_SECRET` to the same value as the portal's
   `GOLEM_BUILD_WEBHOOK_SECRET`, in this repo's Actions secrets.
3. Cut a release, then confirm the portal has the new `config-schema.json`
   cached under its version, and that a tampered body or a stale timestamp is
   refused.

Steps 2 and 3 are `owner: user`. Step 1 is a review in another repo.

## Failure behaviour on this side

The sender's job goes red on failure but the release stays published. So a
missed webhook degrades to *the portal is serving a stale schema* — recoverable,
visible in Actions, and re-runnable via the Release workflow's
`workflow_dispatch`. It must never be able to unpublish or block a release.
