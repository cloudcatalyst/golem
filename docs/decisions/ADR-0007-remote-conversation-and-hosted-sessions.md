---
title: ADR-0007 — Remote conversation: Golem hosts the session, so a device may author a turn
type: adr
tags: [r13, r12, companion-app, remote, autonomy, threat-model, proxy, session, adr-0002, adr-0006]
sources: [docs/decisions/ADR-0002-autonomy-approval-gates.md, docs/decisions/ADR-0006-remote-steering-and-the-companion-app.md, docs/golem-spec.md, docs/plan/verification-notes.md, src/session/session-tree.ts, src/tasks/resume.ts, src/tasks/multiplex.ts, src/proxy/loopback-cert.ts, src/autonomy/gate.ts, src/dashboard/server.ts, src/interfaces/local-answer.ts]
created: 2026-08-22
updated: 2026-08-22
---

# ADR-0007 — Remote conversation: Golem hosts the session, so a device may author a turn

**Status: PROPOSED (2026-08-22).** The *direction* is a USER DECISION of
2026-08-22: *"I'm happy to cross decision 37 and provide a means for remote
conversation collaboration from the users other devices via the companion app,
through whatever mechanism is most similar to conversing via a harnesses chat
window[; ] ideally being able to start new sessions within projects using the
proxy from the companion app is also desirable."* The **constraints** below are
proposed, not yet accepted — §9 lists the three clauses that need an explicit
yes before any build task starts, because each one gives away something this
project has previously refused.

This ADR is the build gate for the R13 series, in the same relationship ADR-0006
had to R12.

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

That argument was correct, and it is the argument this ADR has to answer rather
than dodge. The answer is in §3c: authorship becomes acceptable exactly where
the class line is *enforceable*, and Golem can make it enforceable by owning the
loop instead of guesting in someone else's.

What is already built and load-bearing here:

| what | where | state |
|---|---|---|
| observes every conversation of every harness | `src/session/session-tree.ts` (R8.S3), wired at `src/cli/proxy-runtime.ts` | recording only, "no actuation — Decision 37 stands" |
| conversation identity | `cachePrefixFingerprint`; §99 → R8.13 | fixed |
| the proxy already speaks in a conversation | `src/interfaces/local-answer.ts` (Decision 33) | extractive, single-turn, labelled "**Golem**" |
| the proxy already injects into an outgoing request | `src/pipeline/pipeline.ts` (`brevity.injected`) | shipped, tested |
| spawning a session on the user's behalf | `src/tasks/resume.ts` (`--resume`/`--continue`), `src/tasks/multiplex.ts` | shipped for queued tasks |
| a remote read surface | `src/dashboard/server.ts`; R12.5 | queued, observe-only |
| certificate material for pairing | `src/proxy/loopback-cert.ts` (R9.12) | shipped — Golem is already a CA |

So this is largely a **composition** decision, not a green-field one. What is
genuinely new is authority, retention, and a write path.

## 2. The fidelity target, stated honestly

The user asked for "whatever mechanism is most similar to conversing via a
harness's chat window". Say precisely what that can and cannot mean, so the
companion app is not measured against a promise nobody made.

**Achievable, and required of R13:** typed messages and streamed replies;
visible tool calls and their results as they happen; scrollback that survives a
reconnect; interrupting a running turn; starting a new session in a chosen
project; branching from an earlier point in a recorded conversation; permission
questions answered in place.

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
telemetry, limits and the local-answer path apply exactly as for a local
session, with no side channel to the upstream. The device is a chat client
against that session: it sends messages, it receives streamed turns.

This is the mechanism that satisfies "start new sessions within projects using
the proxy", and it is also the honest answer to "continue or branch on behalf of
the user": Golem does not ghost-type into the developer's terminal, it runs a
session of its own and shows it.

**Why this is primary and not the fallback:** in a loop Golem owns, ADR-0002's
class line is enforceable with a real `deny`. The gap R12.11 found — that
`src/autonomy/gate.ts` types `GateEmission` as `"allow" | "ask" | null`, so it
can only ever *request* a question and never refuse — is a property of being a
guest in the harness's hook chain. It does not exist in a loop whose scheduler
is Golem's.

The runner is **the `claude` CLI the user already has**, spawned as a
subprocess, not a new SDK dependency — `src/tasks/resume.ts` already does this
for queued tasks, so the five-dep runtime pin holds. Whether that CLI's
streaming input mode actually supports a multi-turn conversation of this shape
is **unverified**, and is R13.1's entire job. If it does not, R13.1 reports that
and this section is revised before anything is built on it.

### 3b. Secondary — join a live harness session (capability 3, "author")

For a session the developer is already running, the device's message is queued
and delivered as an injected block on that conversation's **next request**. In
an agentic loop that is seconds away; in an idle session it is never, and the UI
must say exactly that rather than spin.

Two properties make this worth having despite being second-class:

- it is **harness-agnostic by construction** — no channel, no launch flag, no
  allowlist, no client cooperation; it works for any harness pointed at the
  proxy;
- unlike a channel notification, **delivery is synchronous in the request
  path**, so Golem knows whether the message landed. §136's decisive objection
  to a "continue" button — "Claude Code doesn't acknowledge notifications…
  drops the events silently and returns no error to your server" — does not
  apply to injection.

Anthropic's channels MAY later be added as an *optional delivery adapter* where
available. They are not the foundation: flag-gated per session, off the curated
allowlist (`--dangerously-load-development-channels`), unacknowledged, and
explicitly unstable (§136).

### 3c. The rule that makes authorship acceptable

> **Remote authorship is permitted only where enforcement is real.**

Concretely: the send path is *enabled* only when the receiving session's tool
calls are subject to a decision Golem can actually make — a hosted session
(§3a), or a live session where R12.12's `PermissionRequest`-level `deny` is
registered and active (§3b). Where neither holds, the send path is **disabled
and says why**. It never degrades to "send anyway".

This answers Decision 59(g) on its own terms. Authoring a turn is still a larger
authority than answering one; the difference is that the authored turn now lands
inside a loop where `destructive` and `outward` are refused rather than merely
questioned.

## 4. Capability table (extends ADR-0006 §84)

| # | Capability | What it grants | Risk | Status |
|---|---|---|---|---|
| 1 | Observe | See project state, blocks, limits | Metadata disclosure | ADR-0006; R12.5 |
| 2 | Authorize | Answer a permission prompt already open | Code execution | Carried first-party by Anthropic's channel relay (R12.7); class line needs R12.12 |
| 3 | **Author** | Send a message into an existing conversation | **Severe** — arbitrary instruction, bounded by the class line of the receiving loop | **This ADR, §3b.** Declined by Decision 59(g); permitted under §3c |
| 4 | **Originate** | Start a new session in a project, or branch a recorded one | **Severe** — as above, plus choosing *where* work happens | **This ADR, §3a.** New tier; did not previously exist |

## 5. Invariants

These are the clauses a reviewer checks code against. Numbered so a task can
cite one.

1. **No authorship without enforcement.** Per §3c. A device may not send into a
   loop whose tool calls Golem cannot refuse. Disabled, not degraded.
2. **The class line survives verbatim.** ADR-0002 invariant 5 is untouched:
   `allow` is never emitted for `destructive` or `outward`. In a hosted session
   those classes are **refused outright** (a real `deny`), and a remote device
   cannot raise them to `ask` — a local human at the machine is the only path.
   No setting changes this.
3. **Silence denies.** Link loss, pairing expiry, an unresolvable project, an
   ambiguous target session, or anything in the remote path throwing produces
   the same outcome as no device existing: no turn authored, no tool allowed,
   and nothing queued that might land later unannounced. Inherited verbatim from
   ADR-0006 §5.
4. **Every remote-authored turn is attributable.** Device id, timestamp and the
   exact text are appended to the action log *before* delivery, and surfaced in
   the local dashboard. An unattributable turn is a bug, not a convenience.
5. **Nothing invisible.** A message injected into a *live* session is visible
   locally — the developer at the keyboard can see what their own phone said
   into their session. Golem does not deliver silent instructions, even from the
   same person.
6. **Redaction before storage, still.** A persisted transcript is redacted by
   the same pipeline, stored local-only under `.golem/` (gitignored), bounded in
   size and age, and removable by one documented command. No transcript content
   leaves the machine except to the upstream the harness was already calling.
7. **Byte-faithfulness holds when nothing is queued.** Injection is opt-in and
   off by default; at compression ≤ 1, a request with no queued remote message
   is byte-identical to today. Recorded-shape tests are required, per the hard
   rule.
8. **A hosted session is not a privileged session.** It runs through the proxy
   with the same redaction, autonomy gate, limits and telemetry as a session the
   developer starts by hand. It gets no exemption, and it is subject to the
   usage-limit park like anything else.
9. **No Golem-operated service in the path.** R12.8/R12.9 stay cancelled. v1 is
   the local network, or a network the user already provides (Tailscale,
   WireGuard, whatever they run). Internet reach is not in scope and does not
   arrive by accident.

## 6. Retention — the genuinely new exposure

The chat surface needs scrollback, and the branch feature needs the actual text
of an earlier turn. So **prompt content must be persisted**, which Golem has so
far avoided: `session-tree.ts` deliberately stores *content hashes, no prompt
content*, and the wiki/KB rules keep raw captures out of git.

Proposed: a local conversation store under `.golem/` (gitignored), redacted
before write per invariant 6, bounded by count and age with the oldest evicted,
with `golem session forget <id>` and a documented delete-everything path. The
store is readable only by the OS user, and it is the *only* place prompt content
lands at rest.

This is the clause most worth arguing about, and it is one of the three in §9. A
conversation store is a durable record of everything the developer said to the
agent, on disk, indefinitely by default. The bounded default and the forget
command are what make it proportionate. The alternative, if the user prefers, is
**ephemeral scrollback only** — in memory, lost on proxy restart — which costs
the branch feature and the reconnect-survives-scrollback property in §2.

## 7. Pairing and transport

A write surface needs authentication in a way a read surface does not, and
R12.4's mTLS work was **cancelled** with capability 2 rather than left standing
(R12.11) — so this ADR cannot inherit it and must re-decide a smaller version.

Proposed, deliberately minimal: LAN-only; the device pairs once via a code shown
on the developer's own machine; pairing mints a device credential from the
existing `src/proxy/loopback-cert.ts` CA, so no dependency is added; credentials
are revocable and enumerable (`golem device list|revoke`); an unpaired browser
still gets the read-only dashboard, because ADR-0006's observe tier is unchanged
and does not require this. Transport is SSE for the stream plus ordinary POSTs
for messages — no WebSocket dependency, keeping the five-dep pin.

## 8. Alternatives considered

- **Channels as the foundation** (Golem becomes an MCP channel). Rejected as a
  foundation, kept as an optional adapter: §136's five objections all still
  hold, and the decisive one is that a feature whose only path is a flag named
  `--dangerously-load-development-channels` cannot ship.
- **Point the user at Remote Control** (`claude --rc`) and build nothing.
  Rejected on the user's own ground: it is Anthropic's client, account and API,
  and it exists for exactly one harness. The proxy seam is universal, which is
  the whole reason Golem sits where it sits.
- **Enqueue-only** (R12.10's safe half — "Add a task for later", nothing runs
  until the laptop picks it up). Rejected as insufficient for what was asked: a
  queue is not a conversation. It survives as the *degraded* mode when
  enforcement is unavailable per §3c, which is a better use for it than a
  headline feature.
- **tmux `send-keys` / keystroke injection.** Rejected, as in Decision 37: it is
  screen-scraping, it is unattributable, and it cannot honour invariant 5.
- **Revive the relay** (R12.8/R12.9) for internet reach. Rejected for v1: it
  reintroduces a hosted service with uptime, abuse and PII duties (Decision
  59(h)) for a capability the user described as "from the users other devices",
  which the LAN and a user-run VPN already cover.

## 9. What needs an explicit yes before R13 builds

Three clauses give away something previously refused. R13.1 (a spike) may
proceed regardless, because it only measures the runner; **R13.2 onward should
not start until these are answered:**

1. **Remote authorship at all** (§3, capabilities 3 and 4) — this reverses
   Decision 59(g)'s outcome, not merely its reason. The user has said yes in
   principle; this asks for a yes to §3c's specific limit (enforcement-gated)
   and to invariant 2 (`destructive`/`outward` refused outright in a hosted
   session, with no remote path to `ask`).
2. **Prompt content at rest** (§6) — persisted transcripts, or ephemeral
   scrollback and no branch feature. A privacy posture change, so it should be
   chosen rather than inherited.
3. **A pairing mechanism that mints credentials** (§7) — small, but it is a new
   trust root on the developer's machine, and ADR-0006's enrolment-is-local-only
   rule has to be restated for it.

## 10. What this does not decide

Push notification when a hosted session needs input (R12.6's question, separate
by design). Internet reach or any relay (stays cancelled). Whether Golem becomes
a channel (an adapter option in R13.7, not a commitment). Multi-user or team
access — every device here belongs to the same developer. Editing files from the
phone. Running a *non*-Claude harness as the hosted runner: §3b's injection path
is harness-agnostic today, but §3a's runner is the `claude` CLI until someone
writes and verifies a second adapter.

## 11. Amends and supersedes

- **Decision 37** — its product half was already superseded by §136; this ADR
  supersedes the *outcome* that followed from it. The architectural half is
  quoted approvingly in §1, and is exactly why §3b is "next request" rather than
  "now".
- **Decision 59(g)** — capability 3 moves from DECLINED to permitted under
  §3c's enforcement gate. The authority argument is not overturned; it is
  answered.
- **Decision 59(i)** — unchanged for R12.3/R12.4/R12.8/R12.9, which stay
  cancelled. §7 re-decides a strictly smaller pairing mechanism and says so.
- **ADR-0006** — the capability table gains rows 3 and 4 (§4). Its observe tier,
  class line, silence-denies rule and local-only enrolment are inherited
  verbatim, not rewritten.
- **R12.10** — absorbed. Both its questions are answered here: a phone may do
  more than enqueue (so the enqueue surface becomes the degraded mode), and
  Golem does not need to become a channel.
