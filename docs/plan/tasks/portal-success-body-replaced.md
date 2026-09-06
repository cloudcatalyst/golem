---
task: portal-success-body-replaced
title: "The portal documents a success field it does not send — `reason: \"unchanged\"` versus the `replaced` it actually returns"
state: queued
owner: user
size: S
discipline: docs
design: "This repo owns the release webhook's wire contract (`docs/wiki/concepts/Release Pipeline.md` § The portal webhook, § What the portal answers); the portal implements it and does not get to define it — see `docs/wiki/concepts/Portal Install Contract.md` for the direction of truth. The portal's own account of the contract names `{version, stored: false, reason: \"unchanged\"}` on the no-op path. Production has now answered with `replaced` twice: v0.52.1 against a tunnelled local portal (verification-notes §155) and v0.53.0 against the deployed one (§156). The response table in Release Pipeline follows production."
gate: "The portal and this repo agree on ONE shape for the 200 body. Either the portal starts sending `reason` on the `stored: false` path, or its documentation is corrected to `replaced` — and `docs/wiki/concepts/Release Pipeline.md` § What the portal answers is updated to match whichever is chosen, since this repo is where the contract is stated."
blocked: "Needs the portal side to say which shape is real — an outward, cross-repo conversation. The portal repo is at D:/Personal/Projects/Golem, not beside this one."
depends_on: []
touches: ["docs/wiki/concepts/Release Pipeline.md"]
created: 2026-09-06
updated: 2026-09-06
---

## What was observed, twice

```
v0.52.1  {"version":"0.52.1","stored":true,"replaced":false}
v0.53.0  {"version":"0.53.0","stored":true,"replaced":false}
```

Both are the `stored: true` path, so the disagreement is strictly about the
**no-op** path — a re-push of a document already stored. The portal's stated
contract says that answers `reason: "unchanged"`; the field name `replaced`
appearing beside `stored` on the success path suggests the real answer is
`{stored: false, replaced: false}`.

## Why it is harmless today, and why it still needs settling

**Nothing behaves differently either way.** `notify-portal` tests the *status
class* and never reads `stored`, `replaced` or `reason` — a `2xx` is success, and
that is deliberate, because a re-push being a no-op is not a failure.

So this is not a bug; it is a contract that says one thing and does another. It
matters because the next consumer to read the contract — a dashboard, a status
page, anything that wants "did this release change the schema?" — will branch on
a field that is not there, and will do it silently.

Recorded as two shapes rather than resolved unilaterally: [[Release Pipeline]]
§ What the portal answers lists both, noting production is followed. Pick one
here first, then have the portal follow.

## The smallest useful next step

Read the portal's `app/api/webhooks/golem-build/route.ts` no-op branch and see
what it actually returns. That single file settles it, and it is a read, not a
change.
