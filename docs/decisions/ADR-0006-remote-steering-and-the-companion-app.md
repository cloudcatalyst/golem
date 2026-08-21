---
title: ADR-0006 — Remote steering: a paired phone may unblock the agent, but never authorize the irreversible
type: adr
tags: [r12, r6, companion-app, remote, autonomy, threat-model, mtls, security, adr-0002]
sources: [docs/plan/tasks/R6.3.md, docs/decisions/ADR-0002-autonomy-approval-gates.md, docs/decisions/ADR-0003-credential-storage-and-account-routing.md, docs/decisions/ADR-0005-plugin-seams-and-the-redaction-path.md, docs/golem-spec.md, src/hooks/session-state.ts, src/proxy/loopback-cert.ts, src/autonomy/gate.ts, src/dashboard/server.ts]
created: 2026-08-21
updated: 2026-08-22
---

# ADR-0006 — Remote steering: a paired phone may unblock the agent, but never authorize the irreversible

**Status: ACCEPTED (2026-08-21, USER DECISION; spec Decision 59).** Written as the
R6.3 build gate: that task had been blocked since 2026-07-30 on "a threat-model ADR
in the shape of ADR-0002, accepted, BEFORE any code". This is that threat model,
accepted with Revision 2 (the relay) and with the three constraints below
explicitly ratified:

- **enrolment is local-only, forever** — there is no relay-mediated pairing and no
  message type for one (§3c-1);
- **2FA is mandatory** on a relay account (§3c);
- **self-hosting the relay is a standing obligation**, not a courtesy — it is the
  condition on which Alternative 4 stays adopted (§3b).

R12.3–R12.9 are unblocked by this acceptance.

> **Revision 2 (2026-08-21, USER DECISION), before acceptance.** The first draft
> was **LAN-only** and rejected a hosted relay outright, because R6.3's brief lists
> "self-hosted relay only — no Golem-operated service in the path" as a
> non-negotiable. The user reversed that: *"this should be accessible over the
> internet too, not lan only, but it will require an account to relay the companion
> capabilities."* Recorded as a reversal rather than folded in silently. It is
> consistent with spec Decision 20c, which left "relay architecture (self-hosted
> vs. optional golem.run rendezvous)" explicitly **open**, and with Decision 21b's
> "optional cloud account".
>
> This is not a small edit: it introduces a new adversary (anyone on the internet),
> a new trust question (the relay operator, who is us), and a hosted service with
> an availability and abuse obligation. §3b and §3c are the new material, and the
> constraints there are what make the reversal safe rather than merely requested.
> R6.3's non-negotiable is superseded **only** on the "self-hosted only" clause;
> mTLS, default-deny on link loss, and the gate-stays-authority rule all stand.

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
  is *already holding open*. **(Re-verified 2026-08-22, R12.7 — see the block
  under the capability table. A supported reverse channel now exists in the
  client; what remains true is that the *proxy* has none, and that Golem builds
  none. Evidence: verification-notes §136.)**

## The feature, separated into three capabilities

They have wildly different risk and are therefore three separate opt-ins, not one
switch. Most of the value is in the first, which carries almost none of the risk.

| # | Capability | What it grants | Risk |
|---|---|---|---|
| **1. Observe** | Read the blocked state, limits and telemetry from a paired device | Disclosure of tool arguments and project names | Moderate — and bounded by redaction |
| **2. Authorize** | Answer a permission prompt the hook is holding open | Code execution on the developer's machine | **Severe** |
| **3. Resume** | Start work in an idle session | — | ~~Structurally unavailable (Decision 37)~~ — **not built by choice; see the re-verification below** |

Capability 3 is not a design choice. It does not exist, R12.7 re-verifies that
against the current client, and no part of this ADR pretends otherwise.
**[Superseded on the reason, 2026-08-22: R12.7 ran that re-verification and found
the opposite — read this paragraph together with the block below.]**

> **Re-verification (2026-08-22, R12.7) — the row above was right about the
> outcome and wrong about the reason.** Measured against Claude Code `2.1.235`,
> a supported reverse channel into a *running* session now exists and Decision
> 37's "structurally impossible" no longer holds. **Channels** (research preview)
> are the material finding: "a channel is an MCP server that pushes events into
> your running Claude Code session", declared with
> `capabilities.experimental['claude/channel']` and driven by
> `notifications/claude/channel` over stdio — and Golem is already an MCP server.
> **Remote Control** (`claude --rc`) and **cross-session messaging**
> (`SendMessage`, which "starts a new turn" on an idle session) are the other two.
> Anthropic also relays permission prompts to a channel
> (`notifications/claude/channel/permission_request`), which is capability 2 built
> first-party.
>
> **What does not change:** Golem still ships no "continue", and R12.5 still has
> no prompt box. The channel path is opt-in by launch flag per session ("being in
> `.mcp.json` isn't enough"), off the Anthropic-curated allowlist (so
> `--dangerously-load-development-channels` today), unacknowledged by design
> (events "dropped silently, returns no error"), explicitly unstable, and — the
> load-bearing objection — *authoring a turn is a larger authority than answering
> one*, so it sits outside what ADR-0002's class line can constrain and outside
> what this ADR was accepted for. Extending remote authority that far is a new
> USER decision, tracked as **R12.10**, not an amendment an agent may make here.
>
> Full evidence, quotes and URLs: `docs/plan/verification-notes.md` §136. Spec
> Decision 59(g)'s wording ("Capability 3 does not exist") needs a user amendment
> for the same reason.

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

**Revision 2 strengthens rather than weakens this line.** With the relay (§3b) the
approval channel is reachable from the internet rather than from one building, so
the population of possible attackers grows by several orders of magnitude while the
blast radius of a successful one is unchanged. Every argument for keeping
`destructive` and `outward` off the remote path is stronger under Revision 2, and
the class table is identical.

### 3a. Pairing is mTLS with certificates Golem issues; no bearer tokens anywhere

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

**The certificate is the authorization credential, and it is the only one.** This
sentence is what makes §3b and §3c safe: whatever carries the bytes — LAN or
relay — the thing that decides whether a device may approve anything is a client
certificate this machine issued. Nothing an account can do substitutes for it.

### 3b. Two transports, one session: LAN direct, or relayed — and the relay is blind

There are exactly two ways a paired device reaches a session, and they differ
*only* in who carries the packets:

| mode | reachable from | default |
|---|---|---|
| **direct** | the same LAN | **on**, when exposure is enabled |
| **relayed** | anywhere on the internet | **off** — separate opt-in, plus an account |

The mTLS session established in §3a terminates **at the two endpoints and nowhere
else**. The relay is a rendezvous that matches two sockets by an opaque session id
and copies bytes between them. It therefore:

- **Cannot read the traffic.** It holds no key and terminates no TLS. Approval
  requests, tool arguments and decisions pass as ciphertext. A relay compromise —
  including by us — yields metadata, not content, and not authority.
- **Cannot approve anything.** It has no certificate from any user's CA. There is
  no relay-side code path that produces a decision.
- **Cannot enrol a device.** See §3c; this is the single most important limit.
- **Is optional and replaceable.** The protocol is documented and the endpoint is
  a setting, so a user may point at their own relay or at none. "golem.run runs
  one" must never become "golem.run is required" — that is the local-first
  positioning (Decision 32), and it survives only if self-hosting the relay is a
  real, tested path rather than a theoretical one.

**What the relay unavoidably learns**, stated because a "blind relay" claim that
omits this would be dishonest: that an account has a session open, when, between
how many devices, and roughly how much traffic and how often. Timing plus volume
is a work-pattern signal. It does not learn project names, commands, or decisions.

**Relay unavailable = no remote approval**, which is already a safe state: §5's
rule is that silence denies, and a relay outage is silence. It never degrades to a
direct exposure, and it never queues a decision for later delivery.

### 3c. The account authenticates the rendezvous. It never authorizes an approval.

An account is required to use the relay (the user's decision, 2026-08-21). The
whole of its power is: *open a rendezvous slot, and find the other end.* Three
structural limits keep an account compromise from becoming code execution:

1. **Enrolment is local-only, always.** A device is paired at the keyboard, over
   the direct transport, with the fingerprint compared on both screens (§3a).
   **A device can never be paired through the relay.** So an attacker who fully
   owns the account — password, email, session cookie — still cannot introduce a
   device that any laptop will accept. They get a pipe with nothing authorized at
   the far end.
2. **The account cannot revoke, downgrade, or re-issue a certificate.** Trust
   lives in local state on the developer's machine; the account has no write path
   to it. Compromising the account does not un-revoke a stolen phone.
3. **The account is not a config surface.** Consistent with §8: no remote path
   changes settings, autonomy level, hook wiring, or the approvable-class table.

So the honest cost of an account takeover is **denial of service and metadata**,
not RCE. That asymmetry is the design, and it is testable: the acceptance test for
R12.8 is that a fully compromised account cannot cause a single tool call to run.

Two further requirements:

- **The account is for the relay only.** It is not a Golem login, not a licence
  check, and not required for the proxy, the pipeline, the MCP tools, the LAN
  transport, or anything else. A user who never wants remote access never makes
  one. Decision 20c's differentiator narrows honestly: no *Anthropic* org account
  and no org administrator — but a golem.run account, for this one capability.
- **Second factor, and it is not optional for a relay account.** The account
  fronts a channel to a developer's machine; a reused password must not be the
  only thing between an attacker and the pipe. Even bounded by the three limits
  above, DoS against someone's working day is a real harm.

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

- No relay that can read traffic, approve anything, or enrol a device (§3b/§3c).
- No account requirement for any capability other than the relay itself.
- No relay-mediated pairing, at any time, for any reason.
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
| **Anyone on the internet** reaches the approval channel via the relay | **Yes** | The relay carries bytes; the mTLS handshake still terminates on the developer's machine and still demands a certificate from its own CA. Reachability is not authorization. |
| **Relay operator reads traffic** (including us, or whoever compromises us) | **Yes, structurally** | The relay terminates no TLS and holds no key. Ciphertext only. |
| **Relay operator forges an approval** | **Yes, structurally** | It has no client certificate from any user's CA, and no code path emits a decision. |
| **Relay operator learns metadata** | **No** | Account, timing, device count, traffic volume. Stated in §3b rather than mitigated. |
| **Account takeover** (password, email, session) | **Yes, structurally** | Relay-mediated pairing does not exist (§3c-1), the account cannot touch local trust state (§3c-2), and it is not a config surface (§3c-3). An attacker gets a pipe with nothing authorized at the far end. |
| Account takeover denies the user their own remote access | **No** | DoS is the accepted residual cost of §3c. Mitigated only by mandatory 2FA. |
| Relay outage or relay-side attack removes approval | **Yes, by design** | Silence denies (§5). An outage cannot degrade into direct exposure or a queued decision. |
| golem.run becomes load-bearing for the product | **Yes, if enforced** | Documented protocol, configurable endpoint, self-hosting a tested path. This is a *discipline* row: it holds only while someone keeps testing the self-hosted case. |
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
| Push notification puts a third party in the path | **Unresolved, and reopened** | Revision 2 changes this question: a relay that already holds a connection is the natural place to originate a push, so R12.6 must now evaluate relay-originated push as its first option. What a push *payload* may contain is the new sub-question — the answer is "that something is waiting", never the command. |
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

Revision 2 adds four consequences, and they are not small:

- **Golem acquires a hosted service**, with uptime, abuse, and incident-response
  obligations it has never had — and the first one whose failure a user notices.
  R12.9 owns standing it up and is `owner: user` for the same reason R7.6-infra is.
- **A pricing question becomes live.** Decision 20e already names hosted scope as
  the paid-tier candidate; a relay account is the first thing a user could be
  billed for. This ADR does not decide it and must not be read as deciding it.
- **The self-hosted relay is now a maintenance obligation, not a courtesy.** It is
  the only thing keeping §3b's last bullet true, and the only thing keeping
  Alternative 4 adopted rather than rejected.
- **R12.6 reopens.** A held relay connection is the obvious push origin, so the
  spike's first option changed. It stays gated and stays allowed to answer "no".

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
4. **A hosted golem.run rendezvous** for NAT traversal. **Rejected in draft 1,
   ADOPTED in Revision 2 by user decision** (§3b/§3c). The draft's objection was
   that it puts Golem in the path of an RCE channel and makes Golem's compromise
   every user's compromise. That objection is answered structurally rather than
   waived: the relay terminates no TLS, holds no certificate, and cannot enrol a
   device — so compromising it yields metadata and downtime, not authority. The
   local-first positioning (Decision 32) survives on the condition in §3b: the
   endpoint stays configurable and self-hosting stays a tested path. **If that
   condition ever stops being tested, this alternative is back to rejected**, and
   that is the sentence to quote when it happens.
   *Still rejected:* a relay that terminates TLS, inspects traffic, brokers
   approvals, or is mandatory for any other Golem capability.
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
4. **The relay, on the terms in §3b/§3c** — settled in substance by the user's
   2026-08-21 decision; what needs ratifying is the *constraints* added to make it
   safe, and one of them is new:
   - the relay is blind (no TLS termination, no key, ciphertext only);
   - **enrolment is local-only, so an account takeover can never pair a device** —
     this is the new constraint, and it is what keeps account compromise at "DoS
     and metadata" instead of "code execution";
   - the account buys rendezvous and nothing else, with mandatory 2FA;
   - the endpoint stays configurable and self-hosting stays tested;
   - accepting the metadata the relay unavoidably learns (§3b).
5. **Web-first, no native app** until R12.6 proves a native shell buys something
   the web cannot.

On acceptance: add the spec Decisions Log entry (next number is **59**), flip this
Status to ACCEPTED with the date, and unblock R12.3–R12.7.

Related: [[Redaction Stage]], ADR-0002 (the gate this feeds), ADR-0003
(credentials, the other "an attacker gets what?" ADR), ADR-0005 (the precedent for
stating an absent mitigation), Decision 37 (why capability 3 does not exist),
verification-notes §121→§124 (the certificate machinery).
