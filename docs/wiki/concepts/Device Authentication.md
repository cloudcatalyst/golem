---
title: Device Authentication
type: concept
tags: [r13, adr-0007, security, mtls, passcode, devices, write-surface]
sources: ["docs/decisions/ADR-0007-remote-conversation-and-hosted-sessions.md", "docs/plan/verification-notes.md §146", "docs/plan/tasks/R13.4.md", "https://developer.mozilla.org/en-US/docs/Web/API/PublicKeyCredentialCreationOptions"]
updated: 2026-08-29
created: 2026-08-29
---

# Device Authentication

Who may **send**. Two independent claims, both required, neither able to stand in
for the other. Design: ADR-0007 §7, invariants 1, 3 and 8.

| claim | what it proves | how |
|---|---|---|
| **device** | this hardware was paired here | client certificate from the project's device CA, mutual TLS |
| **person** | someone who knows the passcode is present | a live unlock window |

**Failure is denial, never degradation.** A phone with a perfect certificate and a
locked passcode is refused. So is a correct passcode from an unenrolled device.
There is no read-only fallback that pretends a send happened.

## What is NOT gated

The observe tier. [[R12.5 -- the companion app is the dashboard that already existed, bound one interface wider]]
ships a read-only dashboard with **no write route at all**, on a different
server, and an unpaired browser still gets it. Read and write are separate
servers on purpose: "read-only" is then a property of the server rather than of a
route table, and route tables grow.

## Two CAs, deliberately

`src/proxy/loopback-cert.ts` holds both, because it is already a dependency-free
X.509 issuer — but they are separate anchors:

- the **loopback CA** exists so a client trusts *Golem's server*, and its
  certificate is installed in a trust store (`NODE_EXTRA_CA_CERTS`);
- the **device CA** exists so Golem's server can identify *a client*, and it is
  installed nowhere.

Sharing one key would put a key that signs client identities into a file the user
is told to trust for server identities, and would stop a device credential and
the proxy's TLS identity being rotated independently.

## Enrolment is local-only, forever

Inherited verbatim from ADR-0006 §3c-1 (invariant 8). `golem device enrol` runs on
the developer's own machine and mints a short, single-use, ~10-minute code. The
phone POSTs that code to `/enrol/claim` and receives its certificate **once**; the
code is burned before the certificate is returned.

The claim route is reachable over the network and that is not a contradiction: it
can only ever succeed because a human ran the local command seconds earlier, and
at most once. With no pending enrolment on disk there is nothing to check a code
against. **The authority to pair never leaves the machine; only the delivery of
an already-authorised credential does.**

## Revocation is effective on the next request

The catalog is read on **every** authorization and never cached. That is the
whole mechanism — there is nothing that could be stale, so there is no cache
expiry to wait out. A revoked record is kept rather than deleted, so a revoked
credential is distinguishable from an unknown one.

## Why a passcode and not a passkey — MEASURED

Not a fallback. See `docs/plan/verification-notes.md` §146.

The usual suspect — WebAuthn's secure-context requirement — is **not** the
blocker; that is solvable, since an `https://` origin whose chain the device
trusts is a secure context. The blocker is the **Relying Party ID**: per MDN it
"needs to equal the origin's effective domain, or a domain suffix thereof", and a
LAN origin's effective domain is an IP literal, which is not a domain. Omitting
`rp.id` defaults to that same non-domain origin. **No amount of CA trust changes
this** — it is a naming rule, not a transport-security rule.

Re-ask the question at R13.10, where a real domain exists.

## The two windows, and the third check

- **absolute** (`security.unlock_window_minutes`, default 15) — re-enter the
  passcode eventually, however active you were;
- **idle** (`security.idle_relock_minutes`, default 5) — walking away relocks
  sooner;
- **step-up** (`security.step_up_max_age_minutes`, default 2) — high-risk acts
  (gate-map item 5: originating a session) measure against when the passcode was
  *typed*, not last activity. "I unlocked twelve minutes ago" is enough to keep
  reading a stream and is not enough to start an agent session in a repository.

Checking the factor does **not** extend the idle timer; a poll that refreshed it
would mean the timer measured the poller rather than the person.

## Commands

```
golem device enrol <label>     # open a single-use pairing code (local only)
golem device passcode <code>   # set the passcode — also locks any open window
golem device unlock <code>     # open an unlock window
golem device lock              # close it now
golem device list              # every device ever enrolled, with its state
golem device revoke <id>       # effective on its next request
golem device serve [--lan]     # run the mutual-TLS write surface
golem device status            # CA, devices, passcode, window, where it is bound
```

`golem status` carries a one-line summary — where the write surface is reachable
from and how many devices are paired (ADR-0007 invariant 9: if the developer has
put it on a VPN, Golem neither prevents that nor pretends it has not happened).

## Related

[[Autonomy Gate]] · [[Blocked State Read Model]] · [[Configuration Surfaces]] ·
[[Conversation Store]]
