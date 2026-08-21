---
title: ADR-0006 — Remote steering: a paired phone may unblock the agent, but never authorize the irreversible
type: adr
tags: [r12, r6, companion-app, remote, autonomy, threat-model, mtls, security, adr-0002]
sources: [docs/plan/tasks/R6.3.md, docs/decisions/ADR-0002-autonomy-approval-gates.md, docs/decisions/ADR-0003-credential-storage-and-account-routing.md, docs/decisions/ADR-0005-plugin-seams-and-the-redaction-path.md, docs/golem-spec.md, src/hooks/session-state.ts, src/proxy/loopback-cert.ts, src/autonomy/gate.ts, src/dashboard/server.ts]
created: 2026-08-21
updated: 2026-08-21
---

# ADR-0006 — Remote steering: a paired phone may unblock the agent, but never authorize the irreversible

**Status: PROPOSED (2026-08-21).** Written as the R6.3 build gate: that task has
been blocked since 2026-07-30 on "a threat-model ADR in the shape of ADR-0002,
accepted, BEFORE any code". This is that threat model. R12.3–R12.7 do not start
until it is accepted, and **"do not build this" is an outcome this document is
willing to reach** — see Alternatives.

## Context

Spec Decision 21b: the job is *letting a remote human keep the agent unblocked* —
observe a session, and respond to the thing it is stuck on. Decision 20c adds the
transport intent: attach to a running local Golem session from a phone over
Golem's **own** auth, with no Anthropic organisation account, positioned against
Claude's org-gated Remote Control.

The capability underneath is the uncomfortable part, and it is worth stating in
one sentence before any design: **remote permission approval is remote
authorization of code execution on the developer's machine.** It is the exact
capability ADR-0002 exists to constrain, reached from the device most likely to be
lost in a taxi.

Three facts about the existing tree bound this design, all verified 2026-08-21:

- **The observation half is already built and already safe.**
  `runNotificationHook` (`src/hooks/session-hooks.ts`) records the blocked state to
  `.golem/state/session.json`; `src/dashboard/server.ts` serves it at `/api/state`,
  bound to `127.0.0.1`, read-only, unauthenticated. `session-state.ts`'s own header
  calls a network surface "21b's later, guarded step."
- **Golem is already a certificate authority.** `src/proxy/loopback-cert.ts`
  (R9.12, verification-notes §121→§124) hand-encodes X.509 CA and leaf
  certificates over `node:crypto`, with `nameConstraints` and `pathlen:0`, and its
  tests parse every result back through `X509Certificate`. mTLS therefore needs no
  new dependency — the project pins five.
- **There is no reverse channel into the client.** Decision 37: the proxy sits
  below Claude Code as a request relay, `/resume` is a client-side slash command
  the proxy never sees, and the only techniques that reach a live TUI are
  `tmux send-keys` and keystroke injection, which Golem rejected on purpose. A
  phone cannot type into a running session. It can only answer a question the hook
  is *already holding open*.

## The feature, separated into three capabilities

They have wildly different risk and are therefore three separate opt-ins, not one
switch. Most of the value is in the first, which carries almost none of the risk.

| # | Capability | What it grants | Risk |
|---|---|---|---|
| **1. Observe** | Read the blocked state, limits and telemetry from a paired device | Disclosure of tool arguments and project names | Moderate — and bounded by redaction |
| **2. Authorize** | Answer a permission prompt the hook is holding open | Code execution on the developer's machine | **Severe** |
| **3. Resume** | Start work in an idle session | — | Structurally unavailable (Decision 37) |

Capability 3 is not a design choice. It does not exist, R12.7 re-verifies that
against the current client, and no part of this ADR pretends otherwise.

## The honest part

Following ADR-0005's precedent, the rows with no mitigation come before the
design, not buried after it:

- **A paired, unlocked device is authority to run code on the developer's
  machine.** No property of this design prevents that. It is the feature. The
  mitigations below reduce *what* it can authorize and *for how long*, and they
  make theft recoverable — they do not make a stolen unlocked phone harmless.
- **A remote human approves with less context than a local one.** They see the
  command; they do not see the conversation that produced it, the diff in the
  editor, or the last thing they typed. Approving from a phone is genuinely worse
  decision-making, and the design's answer is to narrow what may be approved that
  way rather than to claim the phone is equivalent.
- **Redaction makes the payload safe to transmit, not safe to publish.** A
  redacted `Bash(…)` argument still discloses file paths, project names and what
  the developer is working on to anyone holding the device.

## Decision

### 1. Observe is separately opt-in, and ships first

Capability 1 requires pairing but **not** the authorize opt-in. A user may run a
phone-shaped dashboard forever without any device on earth being able to approve
anything. `golem status` states which capabilities are enabled.

The read model is R12.2's, and **everything in it is redacted before it is
written** (`src/pipeline/redaction.ts`), not before it is sent. Same rule as
everything else, no new exception: the file that a local status line reads and the
payload a phone reads are the same bytes.

### 2. The autonomy gate stays the authority — and this design requires no amendment to ADR-0002

ADR-0002's invariant 5 is *"Removing the human entirely. Impossible: there is no
level whose matrix auto-allows destructive/outward."* Remote approval does not
remove the human; it relocates them. But relocating them must not quietly widen
what may be auto-allowed, so:

**A remote device may authorize only the classes a phone-sized amount of context
is adequate for. `destructive` and `outward` are NEVER remotely approvable.**

| `classifyAction` class (ADR-0002) | Remotely approvable? |
|---|---|
| `read` | Yes |
| `write` | Yes |
| `unknown` | Yes — this is most of the value; `unknown` is any un-allow-listed Bash, and it is what the agent actually blocks on |
| `destructive` (`rm -rf`, `git reset --hard`, `dd`, …) | **No. Waits for the laptop.** |
| `outward` (`git push`, `gh pr`, `npm publish`, `ssh`, `wiki_upsert`, …) | **No. Waits for the laptop.** |

Consequences of drawing the line here, all deliberate:

- ADR-0002's threat model survives verbatim. `allow` is still never emitted for
  destructive or outward, at any autonomy level, from any device.
- A stolen phone cannot push, publish, deploy, `ssh` or delete. The blast radius
  of device theft is "can run a command the thief can also read on screen",
  not "can nuke the repo and ship to npm".
- The classifier's fail-closed default (ADR-0002: anything unrecognized is
  `unknown`) now cuts the *other* way for the escalated classes — a novel
  destructive command that the patterns miss lands in `unknown` and therefore
  **is** remotely approvable. This is a real limitation of reusing the classifier
  and it is why `unknown` remote approval must carry a full-text display of the
  command, never a summary (R12.5).
- Remote approval is only ever *permission to proceed with a specific pending
  request*. There is no remote surface that changes the autonomy level, wires a
  hook, edits settings, or writes config. ADR-0002's item 4 (level tampering)
  stands: the level is settable only by the explicit local CLI.

### 3. Pairing is mTLS with certificates Golem issues; no bearer tokens anywhere

- Golem acts as its own CA (`loopback-cert.ts`), issuing one client certificate
  per device. The server sets `requestCert: true`, `rejectUnauthorized: true`, and
  trusts only that CA.
- **No bearer token, in any URL, header, or QR payload** — R6.3 is explicit, and a
  token in a URL ends up in history, logs and screenshots.
- Enrolment displays a fingerprint on **both** screens for the human to compare.
  Pairing is a deliberate act at the keyboard, never initiated by the phone.
- The device's private key is generated **on the device** and never transmitted.
- The listener binds `127.0.0.1` by default. Reaching it from a phone requires an
  explicit, persisted, loudly-surfaced exposure setting, in the manner of
  `proxy.bypass_all` (ADR-0004), reflected in `golem status`.
- LAN only. No relay, no rendezvous, no NAT traversal, and **no Golem-operated
  service in the path** — if a future capability cannot be delivered without a
  third party, it is named (see R12.6 on push) rather than quietly admitted.

### 4. A decision answers exactly one request, once

A remote approval is bound to `{session, tool, digest of the exact input, nonce
Golem generated, deadline}`. A decision that does not match all five is discarded
and the discard is recorded. Specifically: a decision cannot be replayed onto the
next request, cannot answer a request whose input differs by one byte, and cannot
be used twice.

### 5. Silence denies. Always.

Three separate failures collapse into one behaviour:

- the deadline passes with no answer,
- the link drops,
- anything in the remote path throws.

All three produce **the same outcome as no remote device existing**: the hook makes
no `allow` decision and the local prompt governs. This inherits ADR-0002's
failure-mode 1 unchanged — *no path emits `allow` on error* — and it is the
mechanism behind R6.3's "default-deny on link loss", not merely its intention.

The window itself is a per-hook `timeout` in `.claude/settings*.json`, which Golem
already writes elsewhere (`POST_TOOL_USE_TIMEOUT_SECONDS = 30`,
`WEB_FETCH_PRE_TIMEOUT_SECONDS = 15`). The `PreToolUse` hook currently sets none
and runs on the client's default. **R12.3 must measure the real ceiling and set
the value explicitly** rather than inherit it; and the added wait must be
conditional on a paired device existing, because CLI hot-path latency is a
standing constraint (Decision 51).

### 6. Revocation works while the phone is off

`golem device revoke` refuses a fingerprint from local state, with no online
check and no cooperation from the device. Revocation that needs the lost phone to
answer is not revocation.

### 7. Every remote decision is auditable locally

Applied, timed out, and discarded decisions all append to the autonomy log
(`.golem/state/autonomy-log.jsonl`, ADR-0002 item 6), naming the device
fingerprint and the request answered. R11.7's standard applies: Golem's own
records answer "did Golem do this?" without inference.

### 8. What we deliberately do NOT do

- No hosted relay, rendezvous, or account. No Golem-operated service.
- No remote surface that changes settings, autonomy level, or hook wiring.
- No "continue", no prompt injection, no `tmux send-keys`, no PTY wrapper
  (Decision 37).
- No approval action reachable from a lock-screen notification preview, and no
  swipe-to-approve gesture.
- No remote approval of `destructive` or `outward`, at any autonomy level, with
  any setting. There is no flag for this.
- No native app in the first build (R12.5): the existing dependency-free HTML
  page, made responsive and installable, is a companion app on every platform
  with no store, no signing and no second toolchain — the same discipline that
  removed ink and React (Decision 51).

## Threat model

Every "Yes" is a property of the design. No row is mitigated by "the user will be
careful."

| Threat | Mitigated? | Why / what actually stops it |
|---|---|---|
| Someone on the LAN reads the session state | **Yes** | mTLS with a Golem-issued client cert; unpaired clients fail at the handshake. |
| Someone on the LAN approves a tool call | **Yes** | Same. There is no token-bearing path to approval. |
| Thief with an **unlocked** paired phone runs a command | **No** | This is the feature. Bounded by §2 (never destructive/outward) and by revocation. |
| …and pushes to git / publishes / deploys / deletes the tree | **Yes, structurally** | `destructive` and `outward` are not remotely approvable at any level. No setting changes this. |
| …and changes the autonomy level to widen what is auto-allowed | **Yes** | No remote surface writes config or level; ADR-0002 item 4. |
| Thief with a **locked** phone | **Yes, partly** | Client key sits behind the device's own keystore/screen lock; Golem's mitigation is offline revocation. |
| Lost phone, laptop asleep | **Yes** | Revocation is local state, applied at the next handshake; the phone is never consulted. |
| Replayed "approve" applied to the next request | **Yes** | Decision binds session + tool + input digest + nonce, single-use, with a deadline. |
| Link drops mid-approval, request proceeds | **Yes, structurally** | Silence is not `allow`; the local prompt governs. Same code path as "no device". |
| Remote path crashes and auto-approves | **Yes, structurally** | Inherits ADR-0002 failure-mode 1: catch everything, emit nothing. |
| Malicious app on the phone drives the browser | **No** | Same authority as the human holding it. Reduced by §2's class limits. |
| Tool arguments leak secrets to the device | **Yes, mostly** | Redacted before being written, by the same stage as everything else. Residual: paths and project names are not secrets but are disclosure. |
| A novel destructive command the classifier misses is remotely approved | **No** | It classifies as `unknown`. Stated in §2; the answer is full-text display, not a claim of coverage. |
| Push notification puts a third party in the path | **Unresolved** | R12.6 answers it with dates. "No reliable self-hosted path" is an acceptable answer; the app then polls while open. |
| Remote human approves with worse context than local | **No** | Acknowledged above. §2 narrows what that judgment can reach. |

## Consequences

- **Observation ships first and cheaply.** R12.2 opens no network surface at all;
  the phone view (R12.5) is a responsive treatment of a page that already exists.
- **The dangerous half is one task, gated, and narrow.** R12.3 touches the hook
  and the gate, and its acceptance test is that the unpaired path is unchanged
  byte-for-byte.
- **`destructive`/`outward` blocks still require the laptop.** That is a real
  product limitation and the honest description of the feature: *a phone keeps the
  agent moving; it does not let you ship from the beach.*
- **The mTLS work is smaller than it looks** and adds no dependency, because
  R9.12 already paid for the certificate machinery.
- Two names collide: `golem devices` is the existing inference-target surface.
  R12.4 resolves the collision rather than inheriting it.

## Alternatives considered

1. **Do not build it.** Genuinely on the table — the local prompt already works,
   and the laptop is usually in the room. Rejected only because Decision 21b's
   case (the agent stops, and the human is 20 minutes away) is a real cost that
   recurs daily, and because §1's observe tier delivers most of the value at a
   fraction of the risk. If the user declines the authorize tier, **capability 1
   alone is still worth shipping** and R12.3 can be cancelled on its own.
2. **Allow remote approval of every class, with per-class opt-in settings.**
   Rejected: it converts the one property that makes device theft survivable into
   a checkbox, and a checkbox that exists will be ticked. The asymmetry is the
   point.
3. **Bearer token over HTTPS instead of mTLS.** Rejected by R6.3 directly, and
   because a token is copyable and leaks through URLs, history and screenshots
   where a client certificate in a device keystore does not.
4. **A hosted golem.run rendezvous** for NAT traversal. Rejected: it puts Golem in
   the path of an RCE channel, which contradicts the local-first positioning
   (Decision 32) and would make Golem's own compromise a compromise of every user.
5. **Approve via a push notification action.** Rejected: it is approval without
   reading, from a lock screen, and R6.3 already names push-as-trust-model as out
   of scope.

## What must be ratified before R12.3–R12.7 start

1. **The class line in §2** — that `destructive` and `outward` are never remotely
   approvable, with no setting to change it. This is the load-bearing decision;
   accepting it is what keeps ADR-0002 unamended.
2. **That `unknown` (arbitrary Bash) IS remotely approvable.** Without it the
   feature has almost no use, and with it a paired device has real RCE authority.
   This is the trade this ADR asks the user to make consciously.
3. **The observe/authorize split** — that capability 1 may ship without
   capability 2, and that declining 2 cancels R12.3 and leaves the rest useful.
4. **LAN-only, no relay, ever** — accepting that off-LAN use is simply not
   supported rather than solved by a rendezvous.
5. **Web-first, no native app** until R12.6 proves a native shell buys something
   the web cannot.

On acceptance: add the spec Decisions Log entry (next number is **59**), flip this
Status to ACCEPTED with the date, and unblock R12.3–R12.7.

Related: [[Redaction Stage]], ADR-0002 (the gate this feeds), ADR-0003
(credentials, the other "an attacker gets what?" ADR), ADR-0005 (the precedent for
stating an absent mitigation), Decision 37 (why capability 3 does not exist),
verification-notes §121→§124 (the certificate machinery).
