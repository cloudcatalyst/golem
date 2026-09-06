# team-portal-auth — signing in to the portal from the CLI

**Date:** 2026-09-07
**Task:** `team-portal-auth`
**Tags:** #oauth #pkce #credentials #portal #cli #security #adr-0003 #adr-0008

## Outcome

`golem team link` signs a machine in to the hosted portal with **authorization
code + PKCE over a loopback redirect** (RFC 8252), and puts the resulting access
and refresh tokens in the **OS keychain** — the same seam ADR-0003 already uses
for gateway credentials, not a second one. `golem team status` and
`golem team logout` complete the surface. Nothing org-scoped landed: this task
ends at a stored token and a working `GET /api/v1/me`, and choosing a team is
the `project-team-binding` task's job.

New module `src/portal/` (nine files), new command `src/cli/commands/team.ts`,
new `portal` settings section, and 96 tests.

## What was built

| Piece | File | The property it exists to hold |
|---|---|---|
| PKCE + state | `src/portal/pkce.ts` | `S256` only, no `plain` path to fall into; `state` compared with `timingSafeEqual` |
| Discovery | `src/portal/discovery.ts` | RFC 8414 — endpoints discovered, never hardcoded; https enforced except on loopback |
| Loopback listener | `src/portal/loopback.ts` | Binds the `127.0.0.1` **literal**, ephemeral port, verifies `state` at the boundary |
| Browser | `src/portal/browser.ts` | Argument-array spawn; headless refused honestly rather than by timeout |
| Token endpoint | `src/portal/exchange.ts` | No client secret exists anywhere; `offline_access` asserted before the browser opens |
| Storage | `src/portal/tokens.ts` | Keychain-only write target; token bound to the issuer and client that minted it |
| Client | `src/portal/client.ts` | The one-refresh-then-relink ladder, **counted** |
| Flow | `src/portal/link.ts` | Listener bound before the browser opens; closed in a `finally` |
| Config | `src/portal/config.ts` | Which URL is the API and which is the authorization server |

## Key lessons

### 1. The contract's "one `GOLEM_PORTAL_URL` is enough" is half true, and the half that isn't would have shipped as a bug

`docs/api-contract.md` §1 says a single `GOLEM_PORTAL_URL` plus discovery points
the harness at any environment. That holds for the **authorization server** —
the endpoints really do come from
`<issuer>/.well-known/oauth-authorization-server`. It does not hold for the
**API**: `/api/v1/me` lives on the portal's own domain while the issuer is
Clerk's Frontend API (`https://clerk.<domain>`, or
`https://<slug>.clerk.accounts.dev` in development). Those are different
origins, and **no endpoint in the v1 contract maps one to the other**.

Taking the sentence literally would have produced a harness that discovers
`https://golem.run/.well-known/oauth-authorization-server`, gets a 404, and
reports "the portal is unreachable" on a portal that is perfectly reachable. So
there are two keys: `portal.url` (the API base) and `portal.issuer` (the
authorization server), with `issuer` falling back to `url` — which makes the
contract's claim true for any deployment that publishes the metadata at its own
origin. Recorded in verification-notes; the portal side may want an endpoint
that advertises its issuer, at which point `resolvePortalConfig` is the one
function that changes.

### 2. "Exactly one refresh" is a count, so it is tested as a count

The contract fixes the ladder precisely: *refresh once on `401`, then re-run the
full flow if that also fails*. Written as prose this is easy to implement as a
loop that happens to terminate. It is asserted two independent ways — the
client's own `stats.refreshAttempts`, and the number of POSTs the fake fetch
actually saw at the token endpoint — because a bug that increments the counter
without making the call, or makes the call without counting, passes one and
fails the other.

The subtle case is a token already known to be expired. Spending the request
anyway means burning the one refresh on a `401` that was predictable, so the
client renews pre-emptively — and that renewal **is** the one refresh, not an
extra one. There is a test that pins exactly that.

### 3. "No token under `~/.golem/`" is the wrong invariant on Windows, and the right one is stronger

The gate asks that no token be written under `~/.golem/`. On macOS and Linux
that is literally true — `security` and `secret-tool` hold the secret. On
**Windows there is no keychain daemon**: the platform's OS-backed backend is
DPAPI, which writes a `CryptProtectData` blob to
`~/.golem/credentials/<account>.dpapi`. A path-based assertion would have
failed on Windows for a design that is entirely correct there.

The invariant with actual security content is **"the plaintext token appears in
no file"**, and that is what is asserted — in the unit suite against a fake
keychain, and live on this machine against the real DPAPI backend: 69 files
under `~/.golem` and 2 under the project `.golem` scanned, **0 containing the
plaintext**, with `portal-oauth.dpapi` present and beginning
`01000000d08c9ddf0115d1118c7a00c04fc297eb` — the standard DPAPI header, i.e.
real ciphertext bound to this user and machine.

Consequence for the code: the write target is `"keychain"` explicitly, never
`"auto"` and never `"file"`. `golem gateway login` offers `--store file` as a
documented plaintext escape hatch for headless machines; a portal token gets
none — and cannot need one, because a headless machine cannot complete this flow
at all.

### 4. The headless failure had to be built as a *statement*, not a timeout

Clerk advertises `authorization_code` and `refresh_token` and nothing else —
**no device authorization grant (RFC 8628)**. So a machine with no browser
cannot complete this flow, by portal v1 decision rather than by oversight. Left
alone, such a machine would open no browser, wait five minutes on a listener
nobody will ever reach, and report a timeout — which reads as a flaky network.
`hasDisplay()` checks first and `HEADLESS_MESSAGE` says the true thing: there is
no headless path, run it on a machine with a browser.

### 5. Two keys joined ADR-0008's remote-denied floor, for a circular-trust reason

[[Settings Cascade]] gave the ladder a `team` origin fetched **from the portal**.
`portal.url`, `portal.issuer` and `portal.client_id` are the keys that say
*which* portal that is. A remote origin able to move them could point the next
sign-in at a server of its choosing and harvest the authorization code — a
portal redirecting its own clients elsewhere is not a configuration change, it is
a handover. They now sit alongside `proxy.bypass_all` in
`REMOTE_DENIED_SETTINGS`. `portal.link_timeout_ms` deliberately does not: a team
with slow SSO has a real reason to raise it, and it carries no security weight.

### 6. Windows browser-opening: `rundll32`, not `cmd /c start`

The authorization URL is full of `&`. `cmd /c start` puts it back through a
parser that treats those as command separators; `rundll32.exe
url.dll,FileProtocolHandler <url>` takes it as one argument with no shell
involved, which is what CLAUDE.md's argument-array rule asks for anyway.

## What is verified, and what cannot be

Verified live, end to end, against a local fake authorization server driving the
real CLI: discovery, the `S256` authorization URL, the real loopback listener,
the state check, the code exchange (86-char verifier, **no `client_secret`**),
the keychain write, `GET /api/v1/me` answering 200 with organizations over
`Authorization: Bearer`, and `status`/`logout`. Plus the two named gate items —
a tampered `state` refused with the code never exchanged, and exactly one
refresh before the full flow.

**Not verifiable by an agent:** the leg where a real person signs in and consents
in a real browser at a real Clerk tenant. Registering the OAuth application is
`owner: user` and out of scope by the task's own framing, so there is no client
id, no tenant and no credentials to drive. What that leaves untested is the
portal's *actual* responses — a real `code`, a real token payload, a real
`/api/v1/me` body — as opposed to fixtures shaped from `docs/api-contract.md`.
The first real `golem team link` is where the contract gets checked against
reality.

## Sources

- The portal repo's `docs/api-contract.md` §1 (read 2026-09-06 from the local
  working copy at `D:\Personal\Projects\Golem`) — authoritative on the flow,
  scopes, and the no-device-grant limit
- `docs/plan/verification-notes.md` §149 item 5
- RFC 8252 (OAuth 2.0 for Native Apps), RFC 7636 (PKCE), RFC 8414
  (Authorization Server Metadata), RFC 6749 §5.2 and §6
- `docs/decisions/ADR-0003` (where credentials live),
  `docs/decisions/ADR-0008-settings-cascade-and-importance.md` (the remote floor)

## Related

[[Settings Cascade]] · [[Team Layer]]
