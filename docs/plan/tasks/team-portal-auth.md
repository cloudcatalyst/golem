---
task: team-portal-auth
title: "Sign in to the portal from the CLI — authorization code + PKCE over a loopback redirect, tokens in the OS keychain"
state: queued
owner: agent
size: M
discipline: code
design: "The portal repo's `docs/api-contract.md` §1 is authoritative and gives the exact flow, scopes and gotchas; summarised in `docs/plan/verification-notes.md` §149 item 5. RFC 8252 (OAuth for native apps) is the standard it implements. ADR-0003 is the precedent for where the credential lands."
gate: "`golem team link` on a machine with a browser completes the flow and stores a token the OS keychain can return; `GET /api/v1/me` then answers 200 with the caller's organizations. A tampered `state` is rejected. A `401 unauthenticated` triggers exactly ONE refresh attempt before the full flow is re-run. No token is ever written under `~/.golem/` or into any project file — assert that."
depends_on: []
touches: [src/cli/, src/config/]
created: 2026-09-04
updated: 2026-09-04
---

## What this is

The harness is a **public client**: it ships as source, so it cannot hold a
client secret. That fixes the flow — authorization code with PKCE over a
loopback redirect, `public: true` on the Clerk OAuth application, no secret
anywhere.

## The flow

1. Bind an ephemeral port on `127.0.0.1`; start a one-request HTTP listener.
2. Generate `code_verifier` (43–128 unreserved chars) and
   `code_challenge = BASE64URL(SHA256(verifier))`.
3. Open the system browser at `authorization_endpoint` with `response_type=code`,
   `client_id`, `redirect_uri=http://127.0.0.1:<port>/callback`, `scope`,
   single-use `state`, `code_challenge`, `code_challenge_method=S256`.
4. Listener receives `?code=…&state=…`, verifies `state`, shuts down.
5. POST `token_endpoint` with `grant_type=authorization_code`, `code`,
   `redirect_uri`, `client_id`, `code_verifier`.
6. Store access + refresh tokens in the OS keychain.

## The details that decide whether it works

- **`127.0.0.1`, never `localhost`.** The latter can resolve to IPv6 `::1` and
  mismatch the registered redirect URI.
- **Register the redirect host without a port.** Per RFC 8252 the port is chosen
  at runtime; pinning one is how this breaks on a machine where that port is
  taken.
- **`S256` only** — the server does not accept `plain`.
- **`offline_access` is required** to get a refresh token. Without it the user is
  re-prompted every time the access token expires.
- **Discover, do not hardcode.** Endpoints come from
  `<Clerk Frontend API URL>/.well-known/oauth-authorization-server`, so one
  `GOLEM_PORTAL_URL` plus discovery points the harness at any environment.
- **Refresh once on `401`**, then re-run the full flow if that also fails.

## Where the token goes

The OS keychain — the same place ADR-0003 puts provider credentials.
Explicitly **not** the config directory, and never a file the harness might
later sync. `src/` already has a credential-store seam for gateway accounts;
reuse it rather than adding a second one.

## The limit worth knowing before designing around it

Clerk advertises `authorization_code` and `refresh_token` only. **There is no
device authorization grant (RFC 8628)**, so a machine with no browser cannot
complete this flow at all. That is out of scope for portal v1 by decision, not
by oversight, and the portal's sketched future shape is a device-style approval
page that mints a Clerk-managed API key.

So: do not build a headless path here, and make the no-browser failure say what
is actually true — that headless sign-in does not exist yet — rather than
timing out mysteriously.

## Out of scope

- Anything org-scoped. This task ends at a stored token and a working
  `GET /api/v1/me` → `project-team-binding` chooses and records the team.
- Registering the OAuth application. That is a one-off act by the portal
  operator (`owner: user`), already documented in `docs/api-contract.md` §1.
