---
task: portal-release-webhook
title: "The portal end of the release webhook — accept a signed release.published, verify it, cache the new schema"
state: queued
owner: user
size: S
discipline: code
design: "The harness end is built: `.github/workflows/release.yml` job `notify-portal`. The wire contract — headers, signed material, body — is `docs/wiki/concepts/Release Pipeline.md` § The portal webhook. The portal's own `docs/team-config.md` §2 describes what it does with the schema once it has it."
gate: "A release publishes → the portal has the new `config-schema.json` cached under its version WITHOUT anyone poking it, and a POST with a tampered body or a stale timestamp is refused."
blocked: "lives in the portal repo, not this one, and needs the two GitHub secrets set on this repo — `PORTAL_WEBHOOK_URL` and `PORTAL_WEBHOOK_SECRET`. Both are credentialed acts an agent must not take. Tracked here because the harness half is here."
depends_on: [release-portal-assets]
touches: []
created: 2026-09-04
updated: 2026-09-04
---

## Why it is tracked in this repo

The sending half is here and is already written. This document exists so the
receiving half is not forgotten — the same reason `R7.6-infra` tracks an act
that happens on someone's DNS panel.

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

## Failure behaviour on this side

The sender's job goes red on failure but the release stays published. So a
missed webhook degrades to *the portal is serving a stale schema* — recoverable,
visible in Actions, and re-runnable via the Release workflow's
`workflow_dispatch`. It must never be able to unpublish or block a release.
