---
title: Buzz Integration
type: concept
tags: [r14, r14-2, r14-3, r14-4, buzz, agents, orchestration, personas, acp, harness, nostr, rate-limits]
sources: ["https://buzz.xyz", "https://github.com/block/buzz", "https://github.com/block/buzz/blob/main/crates/buzz-acp/README.md", "https://github.com/block/buzz/blob/main/crates/buzz-acp/src/config.rs", "https://github.com/block/buzz/blob/main/crates/buzz-acp/src/scope.rs", "https://github.com/block/buzz/blob/main/crates/buzz-acp/src/pool.rs", "https://github.com/block/buzz/blob/main/ARCHITECTURE.md", "https://github.com/block/buzz/blob/main/crates/buzz-cli/README.md", "https://agentclientprotocol.com", "https://agentclientprotocol.com/protocol/prompt-turn", "https://github.com/agentclientprotocol/claude-agent-acp/blob/main/docs/session-failure-extension.md", "https://engineering.block.xyz/blog/configuring-agents-in-buzz", "https://engineering.block.xyz/blog/run-your-own-buzz-relay", "docs/plan/verification-notes.md", "src/inference/personas.ts", "src/proxy/limit-prediction.ts", "src/hooks/snooze-nudge.ts", "docs/plan/tasks/R14.2.md", "docs/plan/tasks/R14.3.md", "docs/plan/tasks/R14.4.md"]
updated: 2026-09-19
created: 2026-09-19
---

# Buzz Integration

Design for making Golem a **first-class agent runtime** inside
[Buzz](https://buzz.xyz) — Block's open-source (Apache-2.0,
`github.com/block/buzz`) Nostr-based chat workspace where humans and AI agents
share channels — and for exposing Golem's persona bench ([[Persona Registry]])
and Golem's own orchestrator as addressable agents there. Captured 2026-09-19
from a planning conversation; implementation tracked as R14.3 (the runtime),
R14.2 (identity provisioning), R14.4 (orchestrator dispatch).

**The protocol research is complete**: `docs/plan/verification-notes.md` §19
(2026-09-19) resolves everything §17 and §18 left open, and **§20** (2026-09-19)
adds the rate-limit/usage-cap behaviour, the setup and distribution picture, the
session-scope flag, and one correction to §19. Those sections are the authority
on wire-level facts; this page carries the design and the decisions. Where they
ever disagree, the notes are right and this page is stale.

## Architecture, as confirmed

The relationship runs the opposite way from this page's first draft. In the
**Agent Client Protocol** — a real public protocol from Zed Industries, JSON-RPC
2.0 over stdin/stdout, spec at `agentclientprotocol.com` — the *Client* is the
host and the *Agent* is the AI process it spawns. Buzz's `buzz-acp` crate is
the ACP **Client**. Golem is the ACP **Agent**:

```
Buzz Relay ──WS──→ buzz-acp ──stdio(ACP/JSON-RPC)──→ golem acp
                                                         │
                                                    buzz-cli
                                                 (messages send, …)
```

What Buzz's UI calls a **harness** is simply that subprocess command: `goose` is
`goose acp`, `claude` is the npm adapter `@agentclientprotocol/claude-agent-acp`,
`codex` is `@agentclientprotocol/codex-acp`. Nothing registers *inside* Buzz,
and nothing needs contributing to `block/buzz`.

`buzz-acp` requires exactly four things of an agent: accept `initialize`;
accept `session/new` with `mcpServers` and return a `sessionId`; accept
`session/prompt` and stream `session/update` notifications; return a
`stopReason`. Everything else in ACP is optional and capability-gated.

## Golem as its own runtime, not a `claude`-harness passenger

USER decision (2026-09-19): Golem appears in Buzz as its **own peer runtime** —
`golem`, alongside `goose`, `claude`, `codex` — not as a Claude Code session
running under the existing `claude` harness with Golem's proxy in front of it.
Choosing `golem` means Buzz spawns Golem's own runtime (redaction, compression,
routing, local tools, telemetry — this repo's full pipeline), which decides
internally whether it is acting as the orchestrator or as a given persona.

The decision stands unchanged. Research only made it **cheaper**: it means
shipping a `golem acp` subcommand and pointing `BUZZ_ACP_AGENT_COMMAND` at it,
not writing Rust or forking `buzz-acp`. Two ways to select it:

- **Headless** — set `BUZZ_ACP_AGENT_COMMAND=golem`, `BUZZ_ACP_AGENT_ARGS=acp`
  in the environment of a `buzz-acp` process. No Buzz-side registration at all.
- **Buzz Desktop** — drop a tier-3 "Bring Your Own Harness" JSON at
  `<app-data>/custom_harnesses/golem.json` and `golem` becomes a selectable
  runtime in the picker. The `golem` id is confirmed available: the reserved
  namespace is tier-1 (`goose`, `claude`, `codex`, `buzz-agent`) plus the
  tier-2 presets.

## Inference stays Golem's business

Buzz agent config carries **provider**, **model** and **effort**. Those only
steer tier-1 runtimes whose launch flags Buzz knows. For a tier-3 custom
runtime Buzz spawns `command` + `args` + `env` and nothing more — so a `golem`
runtime reads its model from `inference.personas.<id>.model` and decides effort
through its own routing. Golem never has to write a model or an effort level
into Buzz.

This closes the open question this page previously carried: **Golem does not
need a per-persona `effort` field.** If one is ever wanted it must be justified
on Golem's own routing merits, not as a mirror of a Buzz field that cannot
reach us.

## Why this doesn't map onto Claude Code's `Agent` tool directly

Golem's current persona dispatch ([[Persona Registry]],
`.claude/rules/golem-prefer-persona-agents.md`) is **synchronous**: the
orchestrating session calls the `Agent` tool, blocks, and gets a tool result in
the same turn. Buzz has no equivalent call. An agent is summoned by an event
carrying its pubkey in a `p` tag, takes a turn, and goes quiet.

Decision (2026-09-19, USER): keep the asymmetry rather than papering over it.
Golem's orchestrator **posts the same dispatch content it already builds for
`Agent()` as an `@mention` message**, and treats a reply mentioning it back in
the same thread as the tool-result equivalent. The dispatch prompt content
(task, files, constraints, gate) is unchanged; only the transport and the
completion signal change. The alternative — Agent-tool dispatch as the real
mechanism with Buzz as a read-only mirror — was rejected because it makes Buzz
cosmetic and leaves humans unable to intervene where the work is visible.

### The turn boundary is real, and the orchestrator must respect it

An earlier draft said Golem "watches the thread". It cannot:

- `buzz-acp` holds **at most one prompt in flight per channel**, so blocking on
  a reply deadlocks the channel the reply must arrive through.
- `BUZZ_ACP_IDLE_TIMEOUT` (620s default) cancels a quiet turn; it resets only on
  agent stdout activity, which makes streaming `session/update` the keepalive.
- **A new @mention cancels the turn in flight, by default.**
  `--multiple-event-handling` / `BUZZ_ACP_MULTIPLE_EVENT_HANDLING` defaults to
  `steer` (cancel + re-prompt, framed as a message that arrived mid-task).
  Batched draining into one prompt is the non-default `queue` mode. So a turn
  must survive being cut off part-way through its own posting, not only being
  handed two events at once.
- Unprocessed mentions are **replayed on harness startup**, so the same event
  can arrive twice.
- Session scope is selected by `--session-policy` / `BUZZ_ACP_SESSION_POLICY`
  (`channel` default, `thread` available but shipped dark).

So the orchestrator is a **state machine across turns**, resuming from durable
per-thread state, never a loop inside one. This is R14.4's central constraint.

An optional `--heartbeat-interval` (≥10s) does fire a prompt on an idle agent,
so mention-triggering is not the *only* wake — but it is dropped when busy and
never queued, which makes it a safety net rather than a mechanism. Golem's
orchestrator runs with one anyway (R14.4), because the rate-limit design below
needs *some* unattended wake; the honest framing is that it makes resumption
likely, never certain.

## Rate limits and usage caps: end the turn, say so in the channel

Golem's usage-limit protection ([[Usage Limit Park]], [[Spawn Headroom Gate]])
is a Claude Code `PreToolUse` hook — it denies the next *tool call* and
redirects an *interactive* session to call `snooze`. **None of it reaches a
`golem acp` turn**, which has no tool-call loop and no human present. Nor does
`.golem/state/limit-state.json` get written by it: that file is a side effect of
traffic through Golem's **proxy**, and Golem's in-process dispatcher throws away
response headers and reports a 429 as an unclassified error
(`verification-notes.md` §20 item 1).

Decision (2026-09-19): a rate-limited turn **posts an honest status message with
`buzz messages send`, records the thread as deferred, and returns
`stopReason: end_turn`** — with a small bounded in-turn retry (≤ ~60s) first, so
ordinary per-minute throttling never becomes a channel message. Waiting out the
window inside the turn is not an option worth weighing: `buzz-acp` allows one
prompt in flight per channel, so a parked turn deadlocks the channel its own
resume must arrive through, and a 5-hour Anthropic window outlives
`BUZZ_ACP_MAX_TURN_DURATION` (7200s) regardless.

The channel message is not a stylistic choice — it is **the only path to a
human**. `buzz-acp` never posts a `stopReason` (every value is a `tracing::warn!`
and nothing more), and it drops every `_meta` key it does not already handle, so
the `sessionFailure` extension `@agentclientprotocol/claude-agent-acp` uses for
this exact condition would be swallowed. `end_turn` is also the only safe
stopReason: `max_tokens` and `max_turn_requests` make `buzz-acp` discard the ACP
session, and `refusal` misreports a transient external condition as policy.

What *is* reused from snooze is its **decision**, not its mechanism:
`decideSnoozeNudge()` is already a pure function of a `LimitPrediction`, so Buzz
turns and Claude Code sessions park on the same threshold instead of drifting
apart, and `persistSnoozeNote()` files an operator breadcrumb into
`golem task list`. `runSnooze()` — the part that blocks — is exactly what must
not be reused. Detail and evidence: `verification-notes.md` §20 items 1-3;
build split in R14.3 (detect, retry, post, end) and R14.4 (defer, resume).

## Identity and scoping

- Each persona gets its **own Nostr keypair**. This is Buzz's own instruction,
  not a Golem preference: *"Running multiple agents? Mint a separate keypair for
  each. Every agent needs its own identity."*
- **One `buzz-acp` process per persona.** All subprocesses behind a single
  `buzz-acp` authenticate as the same identity — `--agents N` is a throughput
  dial, not a roster.
- Identities are provisioned **per project**, bound to that project's Buzz
  workspace, the same way `.claude/agents/golem-<id>.md` is generated per
  project. Two Golem projects staffing `golem-coder` get two distinct Buzz
  agents.
- Golem CLI provisions and owns them (USER, 2026-09-19) — `golem buzz provision`,
  wired into the existing persona-sync path so a roster change updates them
  without manual re-entry.
- **Golem mints keypairs; the user registers them.** Relay membership needs
  `buzz-admin add-member --pubkey <hex>` with the relay's own signing key in
  `BUZZ_RELAY_PRIVATE_KEY` — a credentialed operator act. Golem prints the
  command and stops.
- **Secrets never touch the repo.** `BUZZ_PRIVATE_KEY` lives in Golem's
  credential store and is injected at spawn; only pubkeys are committed.

## Mapping: persona → Buzz agent

| Golem persona field | Buzz side |
|---|---|
| persona id (`coder`, `planner`, …) | the agent's Nostr identity + display name; `@mention` resolves by `p` tag |
| `.claude/agents/golem-<id>.md` body | the role prompt, applied by Golem's own runtime — Buzz's "agent instructions" field is not needed for a tier-3 runtime |
| `inference.personas.<id>.model` | **stays on Golem's side** — read at turn time, never written to Buzz |
| effort | **not modelled, deliberately** — unreachable for a tier-3 runtime (see above) |
| fixed: `golem` | `BUZZ_ACP_AGENT_COMMAND` (headless) or the `custom_harnesses/golem.json` id (Desktop) |
| project owner as trust root | `BUZZ_ACP_RESPOND_TO=owner-only` (the default, and the floor Golem sets) |

`owner-only` has a sharp edge worth surfacing in tooling: an agent whose owner
has not resolved responds to **nothing**, which reads as a hang rather than a
permission denial.

## The reverse direction: Golem as an addressable orchestrator

A human or another agent `@mention`s **Golem** in a project's channel (e.g.
`@Golem ship task R14.2`). Golem's orchestrator — its own `buzz-acp` process
with its own identity — wakes, resolves the request the way it does today (task
doc lookup, ambiguity grilling), posts an ack, dispatches by `@mention`-ing the
appropriate persona in-thread with the same content it would pass to `Agent()`,
and **ends its turn**. A reply mentioning Golem wakes it again; it reads its
durable thread state, sequences the next persona, and eventually posts a
summary back to the human.

Personas are also addressable **directly** — `@golem-coder`, skipping the
orchestrator — because each has its own identity with the project owner already
inside its trust boundary. Orchestration through Golem is the common path, not
the only one.

```
@Golem "ship task R14.2"
  -> Golem acks, dispatches @golem-planner with the R14.2 brief, ends its turn
  -> planner replies with a plan, mentioning Golem
  -> Golem wakes, dispatches @golem-coder with brief + plan, ends its turn
  -> coder replies with a diff/PR link
  -> Golem wakes, dispatches @golem-reviewer, ends its turn
  -> reviewer replies with findings
  -> Golem posts the final summary, mentioning the human
```

Posting is done by shelling out to **buzz-cli**, not by an ACP method:
`buzz messages send --channel <uuid> --reply-to <root> --mention <pubkey>
--content -`. `buzz-acp` pre-injects `BUZZ_RELAY_URL`, `BUZZ_PRIVATE_KEY` and
`BUZZ_AUTH_TAG`, so the CLI is already authenticated as that agent. Use
`--mention`, never an inline `@Name` — Buzz matches on the `p` tag, and an
inline handle changes the message body (which is also why the harness's
`!cancel` / `!rotate` / `!shutdown` owner commands need the mention passed
separately).

## External prerequisites Golem cannot ship

`buzz-acp`, `buzz-admin` and `buzz` (buzz-cli) are Rust binaries from
`block/buzz`, and a relay needs Docker Postgres + Redis. Golem detects them on
PATH and reports what is missing; it must not try to build or bundle them, per
`CLAUDE.md`'s no-heavyweight-deps rule. This is what keeps R14.3's live gate an
`owner: user` step.

**There are no prebuilt CLI binaries** — every asset of the latest release
(`desktop-v0.5.23`, 2026-09-05) is a Buzz Desktop installer, and there is no
Homebrew tap or npm distribution, so the documented path is `cargo build
--release -p <crate>`. Two shortcuts are real and worth surfacing in tooling:
`buzz-admin` ships inside the relay container image (`docker run --rm
--entrypoint /usr/local/bin/buzz-admin ghcr.io/block/buzz:main generate-key`),
so key-minting needs no Rust toolchain; and the relay itself can be stood up
with `just setup && just build` + `just relay`, a one-click Railway template, or
a Block-hosted community at `<name>.communities.buzz.xyz` (three per account).
Hosted relays are per-user communities, not a shared public relay.

## Out of scope for this design

- **Buzz persona packs** (`--persona-pack` / `--persona` / `--workdir`,
  per-persona MCP servers, `.agents/skills/`) — the spawn wiring is PR #7359,
  **open and unmerged** as of 2026-09-19. Orthogonal to persona dispatch, and
  not safe to build on yet.
- Buzz's forum, voice/huddle and canvas surfaces beyond channel `@mention` text.
- Writing to Buzz Desktop's `managed-agents.json` — undocumented private state;
  `block/buzz#4869` tracks the control API that would make it legitimate.
- Self-hosting the relay vs using hosted `buzz.xyz` — a deployment choice for
  the user. Note only that tier-3 custom harnesses are documented for **Buzz
  Desktop**; the headless path works either way.

## Still unverified

See `verification-notes.md` §19 item 11 and §20 for the full list. §20 closed
two of the three that mattered — the session-scope flag is `--session-policy` /
`BUZZ_ACP_SESSION_POLICY`, and there is no npm client to wrap instead of
shelling out to `buzz`. What remains, design-first:

- **Whether tier-3 BYOH works against a hosted community.** It reads as a
  client-side runtime seam and so should be relay-agnostic, but nothing says so.
  The headless `buzz-acp` path does not care either way.
- **Whether a hosted community's owner can register an agent pubkey** without
  the relay's signing key. An in-app invite UI is implied by `block/buzz#4209`
  but nobody has walked it. Needs a live account.
- **`thread` session scope on a real relay** — implemented but shipped dark, so
  it deserves observation rather than trust.
- **How `goose acp` and `codex-acp` handle a provider rate limit**, which would
  be corroboration for the design above rather than a dependency of it. Neither
  could be sourced without reading their source directly.
- Everything else that needs a live relay to observe: the NIP-42 handshake, a
  real end-to-end turn, and whether `golem acp` satisfies `buzz-acp` in practice.
