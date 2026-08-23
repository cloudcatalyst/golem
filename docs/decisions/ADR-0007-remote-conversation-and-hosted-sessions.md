---
title: ADR-0007 — Remote conversation: Golem hosts the session, so a device may author a turn
type: adr
tags: [r13, r12, companion-app, remote, autonomy, threat-model, proxy, session, mtls, auth, adr-0002, adr-0006]
sources: [docs/decisions/ADR-0002-autonomy-approval-gates.md, docs/decisions/ADR-0003-credential-storage-and-account-routing.md, docs/decisions/ADR-0006-remote-steering-and-the-companion-app.md, docs/golem-spec.md, docs/plan/verification-notes.md, src/session/session-tree.ts, src/tasks/resume.ts, src/tasks/multiplex.ts, src/proxy/loopback-cert.ts, src/autonomy/gate.ts, src/dashboard/server.ts, src/interfaces/local-answer.ts]
created: 2026-08-22
updated: 2026-08-22
---

# ADR-0007 — Remote conversation: Golem hosts the session, so a device may author a turn

**Status: ACCEPTED (2026-08-22, USER DECISION; spec Decision 60).** The direction
and all three open clauses were decided by the user on the day this was drafted;
Revision 1 below records what they changed, because two of those changes make the
ADR *less* restrictive than the draft they were answering and that should not be
silently absorbed.

This ADR is the build gate for the R13 series, in the same relationship ADR-0006
had to R12.

> **Revision 1 (2026-08-22, USER DECISION), before acceptance.** The draft asked
> three questions (§9) and proposed a fourth constraint the user did not ask for.
> Their answers, verbatim: *"Let's plan for relaying to the internet in the
> future, but leave the current scope limited to lan. I don't want to put any
> limits on remote authorship, maybe we can have some user controls applied once
> we define where possible gates could be. I'm happy to not shift to branching, as
> long as a user can continue a conversation and see the previous messages and
> also launch a new conversation. Please do what you need to do to have secure
> device and user authentication, including reviving the mTLS route."*
>
> Four changes follow, and they pull in both directions:
>
> 1. **The authorship gate is REMOVED.** The draft's §3c made the send path
>    conditional on enforcement being real. It is not conditional any more: a
>    paired, authenticated device may send any message to any session it can
>    see. §3c is replaced by the **gate map** (§3d) — an enumeration of every
>    point where a control *could* sit, so the user can choose which to switch on
>    once they can see the list. **One thing this does NOT silently change:**
>    whether a remote device may *answer* a `destructive`/`outward` permission
>    prompt. Decision 59(a) says never, "with no setting to change it", and
>    reversing that is a Decision 59(a) amendment the user must make explicitly —
>    it is item 3 in the gate map and it is flagged there, not defaulted.
> 2. **Branching is dropped, continuation is not.** The user is content without
>    forking a conversation at an earlier turn, provided a device can *continue*
>    an existing conversation, *see the previous messages*, and *start a new
>    one*. §2 and R13.8 are re-cut accordingly. Retention (§6) survives on the
>    narrower justification: scrollback and continuation still need turn text.
> 3. **mTLS is revived, and user authentication is added.** The draft proposed a
>    deliberately smaller credential than R12.4's cancelled mTLS design. The user
>    reversed that and asked for both device *and* user authentication. §7 is
>    rewritten: mutual TLS for the device, a user factor bound to the person, and
>    re-authentication for the highest-risk actions.
> 4. **The relay is planned, not built.** v1 stays LAN-only, and internet reach
>    becomes an explicit phase 2 (§7c, R13.10) rather than something cancelled.
>    R12.8/R12.9 stay cancelled *as designed*; phase 2 inherits Decision 59(d)–(h)
>    obligations wholesale, including that a hosted relay is blind and that
>    enrolment is local-only forever.

## 1. Context

Decision 37 (2026-07-18) was two claims wearing one sentence, and R12.7 split
them (verification-notes §136):

- the **architectural** half stands, unchanged and unchallenged: the proxy is a
  request relay below the harness. It sees `/v1/messages` and nothing else, it
  speaks only when the harness speaks to it, and no amount of proxying creates a
  user turn in an idle client;
- the **product** half — "no IPC into an already-running interactive session" —
  is false as of client `2.1.235`. Channels, Remote Control and cross-session
  messaging are all supported reverse channels.

Decision 59(g) then *declined* capability 3 (author a turn) on an authority
argument rather than a feasibility one: **authoring a turn is a larger authority
than answering one**, because injected free text can propose anything and so
routes around ADR-0002's class line instead of sitting behind it.

Revision 1 answers that argument differently from the draft, and the difference
is worth stating plainly. The draft answered it by *restricting authorship*. This
ADR answers it by **separating authorship from execution**:

> Text is not authority. A message is a proposal; a tool call is an act. Golem
> gates acts, and it gates them identically no matter who typed the message that
> led to them.

A remotely-authored turn is subject to exactly the same ADR-0002 classification,
the same hooks and the same prompts as a turn typed on the developer's keyboard.
That is not a concession to the remote path; it is the reason the remote path
does not need one.

What is already built and load-bearing here:

| what | where | state |
|---|---|---|
| observes every conversation of every harness | `src/session/session-tree.ts` (R8.S3), wired at `src/cli/proxy-runtime.ts` | recording only, "no actuation — Decision 37 stands" |
| conversation identity | `cachePrefixFingerprint`; §99 → R8.13 | fixed |
| the proxy already speaks in a conversation | `src/interfaces/local-answer.ts` (Decision 33) | extractive, single-turn, labelled "**Golem**" |
| the proxy already injects into an outgoing request | `src/pipeline/pipeline.ts` (`brevity.injected`) | shipped, tested |
| spawning a session on the user's behalf | `src/tasks/resume.ts` (`--resume`/`--continue`), `src/tasks/multiplex.ts` | shipped for queued tasks |
| a remote read surface | `src/dashboard/server.ts`; R12.5 | queued, observe-only |
| certificate material for mTLS | `src/proxy/loopback-cert.ts` (R9.12) | shipped — Golem is already a CA |

So this is largely a **composition** decision, not a green-field one. What is
genuinely new is authority, retention, and a write path.

## 2. The fidelity target, stated honestly

The user asked for "whatever mechanism is most similar to conversing via a
harness's chat window". Say precisely what that can and cannot mean, so the
companion app is not measured against a promise nobody made.

**Achievable, and required of R13:** typed messages and streamed replies; visible
tool calls and their results as they happen; **the previous messages of a
conversation, readable on the device**; **continuing an existing conversation**
across reconnects, app restarts and days; **starting a new conversation** in a
chosen project; interrupting a running turn; permission questions answered in
place, subject to the gate map.

**Dropped by Revision 1:** forking a conversation at an earlier turn. The session
tree still *detects* branches (that is R8.S3's existing behaviour and it stays);
nothing offers to *create* one.

**Not achievable, and not to be implied:** the phone is not a second view of the
TUI on the laptop screen. A **hosted** session (§3a) is a *different session*
from the one the developer is typing into, and the app must name it as such. A
**joined** live session (§3b) can be spoken *to*, but its local scrollback,
`/`-commands, checkpoints and TUI state remain the harness's own and are not
mirrored. Anything that renders a joined session as if the phone were the
terminal is a lie this ADR forbids.

## 3. Decision

Two mechanisms, deliberately unequal. The primary one is the one Golem controls
end to end.

### 3a. Primary — Golem hosts the session (capability 4, "originate")

Golem spawns and supervises an agent session on the developer's machine, in a
chosen project root, **through its own proxy** — so redaction, compression,
telemetry, limits and the local-answer path apply exactly as for a local session,
with no side channel to the upstream. The device is a chat client against that
session: it sends messages, it receives streamed turns.

This is the mechanism that satisfies "start new sessions within projects using
the proxy", and it is the honest form of continuing a conversation on the user's
behalf: Golem does not ghost-type into the developer's terminal, it runs a
session of its own and shows it.

A hosted session is also where Golem's own enforcement is strongest — and, per
R13.1 (verification-notes §142), that strength does not require Golem to own
the loop after all: a *hosted* session running the unmodified `claude` CLI in
headless/stream-json mode cannot open a permission dialog, so a hook emitting
`src/autonomy/gate.ts`'s real `ask` (never `deny`) already resolves to an
effectively-hard synchronous refusal, the same mechanism §141 found for
plain `-p`, now confirmed in the multi-turn hosted shape too. Golem does not
need to write its own agent loop to hold the class line here; it needs its
hook reachable, which R13.1 also confirmed (below). The gate map (§3d) is what
decides when that strength is used.

The runner is **the `claude` CLI the user already has**, spawned as a subprocess,
not a new SDK dependency — `src/tasks/resume.ts` already does this for queued
tasks, so the five-dep runtime pin holds.

**R13.1 (verification-notes §142, client `2.1.235`) verified this.** `claude -p
--input-format stream-json --output-format stream-json` accepts a second user
message on stdin after the first turn's `result` event without exiting, holds
one stable `session_id` across turns, emits tool calls and tool results as
separable structured events, honours `ANTHROPIC_BASE_URL` (invariant 8), and
loads the project's `.claude/settings.json` hooks the same as an interactive
session (invariant 2's precondition). The runner is confirmed; build on it.

Two gaps R13.1 found, not viability failures but open items for whoever builds
R13.3: (1) on Windows, `child.kill("SIGINT")` does not interrupt a running
turn — only killing the process does, so §2's "interrupting a running turn"
needs a platform caveat until a POSIX host confirms the documented SIGINT
behaviour; (2) the usage-limit park (`snooze`) is Golem's own orchestration
concept and a spawned `claude` process is not a participant in it — hitting a
real usage limit inside a hosted session is expected to surface as an
ordinary API-level error in that process, not as Golem's park, and this was
reasoned, not live-confirmed (running an account to its limit was out of
proportion for a spike).

### 3b. Secondary — join a live harness session (capability 3, "author")

For a session the developer is already running, the device's message is queued
and delivered as an injected block on that conversation's **next request**. In an
agentic loop that is seconds away; in an idle session it is never, and the UI
must say exactly that rather than spin.

Two properties make this worth having despite being second-class:

- it is **harness-agnostic by construction** — no channel, no launch flag, no
  allowlist, no client cooperation; it works for any harness pointed at the
  proxy;
- unlike a channel notification, **delivery is synchronous in the request path**,
  so Golem knows whether the message landed. §136's decisive objection to a
  "continue" button — "Claude Code doesn't acknowledge notifications… drops the
  events silently and returns no error to your server" — does not apply to
  injection.

Anthropic's channels MAY later be added as an *optional delivery adapter* where
available. They are not the foundation: flag-gated per session, off the curated
allowlist (`--dangerously-load-development-channels`), unacknowledged, and
explicitly unstable (§136).

### 3c. Authorship is unrestricted (Revision 1)

A paired, authenticated device may send **any message** to **any session it can
see**, hosted or joined. There is no enforcement precondition, no disabled send
box, and no class of instruction Golem refuses to carry.

What follows from that, and is not a limit on the remote path:

- the *turn* is subject to ADR-0002 exactly as a locally-typed turn is. Nothing
  about "a phone said it" makes a tool call more or less permitted;
- the developer at the keyboard still sees what their device said (invariant 4);
- and the question "who may *answer* a permission prompt" is a separate question
  from "who may *ask* for work", governed by Decision 59(a) and by §3d.

### 3d. The gate map — where a control could sit (Revision 1)

The user asked for controls to be defined once the possible gates are visible.
This is that enumeration. **Only the defaults marked "on" ship without a further
decision**; the rest are switches R13.9 builds and the user chooses.

| # | Gate point | What it would control | Default |
|---|---|---|---|
| 1 | **Session visibility** | which sessions/projects a device may see and address (all, hosted-only, an allowlist) | on — all, for the paired device |
| 2 | **Origination scope** | which project roots a device may start a session in | on — all known roots |
| 3 | **Remote answer to `destructive`/`outward`** | whether a device may answer those prompts at all | **off by default, and now unlockable** — Decision 61 (2026-08-22) amended 59(a) at the user's request. On requires: a fresh user-factor re-authentication per answer, loud logging, and the kill switch overriding it. Off keeps 59(a)'s original posture |
| 4 | **Approval routing when nobody is local** | whether a prompt with no local answerer times out (denies) or routes to the device | on — routes to the device for `read`/`write`/`unknown`, per 59(a) |
| 5 | **Re-authentication for high-risk acts** | require the user factor again (not just the device cert) before originating a session, or before answering a prompt | on for origination, off for ordinary messages |
| 6 | **Rate and size limits per device** | flood protection, oversized-message rejection | on, generous |
| 7 | **Kill switch** | one command/one tap that suspends all remote authorship immediately | on, always available |
| 8 | **Quiet hours / presence** | restrict remote authorship by time, or to when the developer is away | off — offered, not assumed |
| 9 | **Per-session pause** | suspend remote authorship for one conversation without unpairing | on |

Item 3 is the one that matters, and it is deliberately the one Golem will not
default. Everything else is convenience; that one is the class line — and per
Decision 61 it is now a setting rather than a wall, which makes the *default* and
the re-authentication requirement the whole of its safety, not the absence of the
control.

## 4. Capability table (extends ADR-0006 §84)

| # | Capability | What it grants | Risk | Status |
|---|---|---|---|---|
| 1 | Observe | See project state, blocks, limits | Metadata disclosure | ADR-0006; R12.5 |
| 2 | Authorize | Answer a permission prompt already open | Code execution | Carried first-party by Anthropic's channel relay (R12.7); class line needs R12.12; gate map item 3 |
| 3 | **Author** | Send a message into an existing conversation | **Severe** — arbitrary instruction; the resulting tool calls are gated as any other | **This ADR, §3b/§3c.** Declined by Decision 59(g); permitted, unrestricted, by Revision 1 |
| 4 | **Originate** | Start a new session in a project | **Severe** — as above, plus choosing *where* work happens | **This ADR, §3a.** New tier; gate map items 2 and 5 |

## 5. Invariants

These are the clauses a reviewer checks code against. Numbered so a task can
cite one. Invariants 1 and 2 were rewritten by Revision 1.

1. **No unauthenticated authorship.** A message is carried only from a device
   holding a valid mTLS credential *and* a live user factor (§7). Authorship is
   unrestricted in content and target; it is never anonymous.
2. **The class line governs acts, not text.** A remotely-authored turn is
   classified and gated exactly as a locally-authored one — no exemption, no
   extra restriction. ADR-0002 invariant 5 is untouched: `allow` is never emitted
   for `destructive` or `outward`. Whether a *device* may answer such a prompt
   is gate-map item 3, governed by Decision 59(a) as amended by **Decision 61**:
   off by default, unlockable by the user, and when unlocked it requires a fresh
   user-factor re-authentication per answer. Golem itself still never emits
   `allow` for those classes — the setting changes who counts as the human, not
   what Golem decides.
3. **Silence denies.** Link loss, credential expiry, an unresolvable project, an
   ambiguous target session, or anything in the remote path throwing produces the
   same outcome as no device existing: no turn delivered, no tool allowed, and
   nothing queued that might land later unannounced. Inherited verbatim from
   ADR-0006 §5.
4. **Every remote-authored turn is attributable and visible.** Device id, user
   identity, timestamp and the exact text are appended to the action log *before*
   delivery, and surfaced locally — the developer at the keyboard can see what
   their own device said into their session. Golem does not deliver silent
   instructions, even from the same person.
5. **Redaction before storage, still.** A persisted transcript is redacted by the
   same pipeline, stored local-only under `.golem/` (gitignored), bounded in size
   and age, and removable by one documented command. No transcript content leaves
   the machine except to the upstream the harness was already calling.
6. **Byte-faithfulness holds when nothing is queued.** Injection is opt-in and off
   by default; at compression ≤ 1, a request with no queued remote message is
   byte-identical to today. Recorded-shape tests are required, per the hard rule.
7. **A hosted session is not a privileged session.** Same redaction, autonomy
   gate, limits and telemetry as a session the developer starts by hand. No
   exemption, and it parks at the usage limit like anything else.
8. **Enrolment is local-only, forever.** Inherited verbatim from ADR-0006 §3c-1
   and it survives phase 2: there is no relay-mediated pairing and no message type
   for one, so a compromised relay or account cannot introduce a device any
   laptop will accept.
9. **v1 is LAN-only; the internet is phase 2 and arrives by decision, not by
   accident.** No Golem-operated service is in the path today. §7c plans one; it
   does not ship one, and nothing in v1 may be built in a way that makes phase 2
   automatic.

## 6. Retention

Scrollback ("see the previous messages") and continuation ("continue a
conversation") both need turn text on disk, so **prompt content must be
persisted** — which this project had so far refused: `session-tree.ts`
deliberately stores *content hashes, no prompt content*.

Accepted (§9 clause 2, answered): a local conversation store under `.golem/`
(gitignored), redacted before write per invariant 5, bounded by count and age
with the oldest evicted, with `golem session forget <id>` and a documented
delete-everything path. The store is readable only by the OS user, and it is the
*only* place prompt content lands at rest.

Revision 1 narrows the justification: this is no longer needed for branching,
which is dropped. It is needed for the two things the user did ask for. Size the
bounds for that — enough history to continue a conversation and read back what
was said, not an indefinite archive of everything.

## 7. Authentication (rewritten by Revision 1)

The draft proposed a deliberately smaller credential than R12.4's cancelled mTLS
design. The user reversed that: *"do what you need to do to have secure device
and user authentication, including reviving the mTLS route."* So this section
revives R12.4's mechanism for a write surface, and adds the factor R12.4 never
had — the **user**, as distinct from the device.

### 7a. Device — mutual TLS

Golem is already a certificate authority (`src/proxy/loopback-cert.ts`, R9.12), so
mTLS adds no dependency and the five-dep pin holds — the same reasoning ADR-0006
recorded when it chose mTLS the first time. A device pairs once, locally
(invariant 8), and is issued a client certificate. The server requires and
verifies a client certificate on every write endpoint. Certificates are
enumerable, revocable with immediate effect, and carry a device label and
last-seen so a stale one is visible.

### 7b. User — a factor bound to the person

A certificate proves *a device*, not *a person*, and a device is lost, borrowed
and stolen. So the send capability additionally requires a user factor: a
passkey/WebAuthn credential where the platform supports it in this context, and a
passcode as the universal fallback. It unlocks for a bounded session, re-prompts
after idle, and is re-required for gate-map item 5's high-risk acts. R13.4
verifies what is actually available to a browser on a LAN origin served with a
private CA's certificate — a secure-context question that must be *measured*, not
assumed, before the passkey path is promised.

Failure is denial, never degradation: no factor, no send. The read-only observe
tier is unchanged and requires none of this (ADR-0006 shipped it without pairing).

### 7c. Transport

SSE for the downstream stream plus ordinary POSTs for messages, over the mTLS
listener. No WebSocket dependency, so the five-dep pin holds and the dashboard
stays the framework-free page Decision 51's discipline produced.

### 7d. Phase 2 — the relay, planned

Internet reach is deferred, not cancelled. When it comes (R13.10) it inherits
Decision 59(c)–(h) wholesale rather than re-litigating them: the relay is
**blind** (it copies ciphertext between two sockets, terminates no TLS, holds no
key, has no code path that emits a decision), the account buys rendezvous and
nothing else, 2FA is mandatory, self-hosting stays a tested path, and enrolment
remains local-only (invariant 8) so a compromised account yields a pipe with
nothing authorized at the far end. The mTLS session in §7a is what phase 2
carries end-to-end, which is the second reason to build it now rather than
something smaller: **v1's device credential is phase 2's transport security.**

## 8. Alternatives considered

- **Channels as the foundation** (Golem becomes an MCP channel). Rejected as a
  foundation, kept as an optional adapter: §136's five objections all still hold,
  and the decisive one is that a feature whose only path is a flag named
  `--dangerously-load-development-channels` cannot ship.
- **Point the user at Remote Control** (`claude --rc`) and build nothing.
  Rejected on the user's own ground: it is Anthropic's client, account and API,
  and it exists for exactly one harness. The proxy seam is universal, which is
  the whole reason Golem sits where it sits.
- **Restricting authorship to enforceable targets** (the draft's §3c). Rejected
  by Revision 1: it made the send box's presence depend on a condition the user
  could not see, and the honest place for a limit is a control the user chooses
  (§3d), not a silent precondition.
- **Enqueue-only** (R12.10's safe half). Rejected as insufficient: a queue is not
  a conversation. It survives as the degraded mode for an idle joined session.
- **tmux `send-keys` / keystroke injection.** Rejected, as in Decision 37: it is
  screen-scraping, it is unattributable, and it cannot honour invariant 4.
- **A smaller-than-mTLS device credential** (the draft's §7). Rejected by
  Revision 1 in favour of reviving mTLS, which is also what phase 2 needs.

## 9. Open clauses — all three answered (2026-08-22)

1. **Remote authorship** — ACCEPTED, and *widened*: no limits (§3c), with
   controls enumerated in §3d for the user to choose from. Gate-map item 3
   (remote answers to `destructive`/`outward`) was unlocked by **Decision 61**
   the same day — a setting, off by default, re-authenticated per answer.
2. **Prompt content at rest** — ACCEPTED (§6), on the narrower justification of
   scrollback and continuation, since branching is dropped.
3. **Pairing that mints credentials** — ACCEPTED and *enlarged* to mTLS plus a
   user factor (§7).

R13.1–R13.10 are unblocked by this acceptance, subject to their own
`depends_on`.

## 10. What this does not decide

Push notification when a hosted session needs input (R12.6's question, separate
by design). Whether Golem becomes a channel (an adapter option in R13.7, not a
commitment). Multi-user or team access — every device here belongs to the same
developer, and anything else is a different ADR. Editing files from the phone.
Whether gate-map item 3 should ever default to on (it should not; Decision 61(d)
states the blast radius).
Running a *non*-Claude harness as the hosted runner: §3b's injection path is
harness-agnostic today, but §3a's runner is the `claude` CLI until someone writes
and verifies a second adapter.

## 11. Amends and supersedes

- **Decision 37** — its product half was already superseded by §136; this ADR
  supersedes the *outcome* that followed from it. The architectural half is
  quoted approvingly in §1, and is exactly why a joined message lands on the
  *next* request rather than now.
- **Decision 59(g)** — capability 3 moves from DECLINED to permitted and
  unrestricted (§3c). The authority argument is answered by separating text from
  acts, not by overruling it.
- **Decision 59(a)** — amended by **Decision 61** (2026-08-22, USER DECISION),
  and only in its "no setting to change it" clause: gate-map item 3 is now a
  control, off by default. Revision 1 of this ADR did *not* make that change; a
  separate user decision did, and the distinction is worth keeping because the
  default is now the entire safety margin.
- **Decision 59(i)** — R12.3/R12.4/R12.8/R12.9 stay cancelled *as designed*. §7a
  revives R12.4's **mechanism** for a different purpose (authenticating a LAN
  write surface, and carrying phase 2), and §7c plans the relay as phase 2 rather
  than reinstating R12.8/R12.9's briefs.
- **ADR-0006** — the capability table gains rows 3 and 4 (§4). Its observe tier,
  class line, silence-denies rule and local-only enrolment are inherited
  verbatim, not rewritten.
- **R12.10** — absorbed. Both its questions are answered here: a phone may do
  more than enqueue, and Golem does not need to become a channel.
