---
title: Session Transport
type: concept
tags: [r13, adr-0007, sse, transport, wire-protocol, idempotency]
sources: ["docs/decisions/ADR-0007-remote-conversation-and-hosted-sessions.md", "src/interfaces/session-events.ts", "docs/plan/tasks/R13.5.md"]
updated: 2026-08-29
created: 2026-08-29
---

# Session Transport

The wire between a [[Hosted Session]] and a device. **SSE downstream, POST
upstream** (ADR-0007 §7c) — no WebSocket, which is what holds the
five-dependency pin: `text/event-stream` is a content type and a newline
convention, and `node:http` already has both.

Mounted **behind** [[Device Authentication]]'s write server, so every route has
already presented a device certificate and a live user factor. The transport
contains no authentication of its own: two places that decide who may write is
one place too many.

```
GET  /session/<id>/stream    # SSE; resume with Last-Event-ID or ?after=
POST /session/<id>/message   # {"messageId": "...", "text": "..."}
```

Run it: `golem session host serve [--lan]`.

## The event shapes

Named in `src/interfaces/session-events.ts` as a **frozen contract**, because
R13.6's chat surface codes against them and so will anything after it.

| event | meaning |
|---|---|
| `attached` | sent first, before any replay: which session, resuming from where, and whether there is a **gap** |
| `text` | assistant prose, as it arrives |
| `tool_call` | a tool the session decided to call — visible, per ADR-0007 §2 |
| `tool_result` | what came back; `isError` is how a **refusal** arrives |
| `refused` | the runner's OWN guard blocked something — a different fact from a host deny |
| `turn_end` | a turn finished |
| `parked` | the usage-limit park fired; alive and deliberately not spending |
| `ended` | the session is over, and why |

Every event carries a **`seq`**, monotonically increasing per session. That is
what makes reconnect-without-loss-or-duplication possible at all.

## Connection state is an event, never an inference

ADR-0006's rule — *"a dropped link shows not connected, never a stale approved"* —
is inherited here for conversation, where the same failure looks like **a message
the user believes they sent**.

So a client is *told* the session ended, parked or died. It must never conclude
it from silence — and that is why heartbeats exist: an SSE comment every 15s
means **silence means "still here"**, never "gone".

## Resume, and the gap

A client reconnects with `Last-Event-ID` (what `EventSource` sends automatically)
or `?after=` (what an explicit client controls). Both are read, because ignoring
either would silently restart one kind of client from nothing.

The server replays strictly what came after that cursor, from a bounded ring
(500 events). If the cursor has already fallen out, `attached` carries
**`gap: true`** — the client has missed something and must say so. *A gap the
user can see is recoverable; a gap they cannot is a conversation they will
misread.*

## Backpressure: drop the client, never stall the session

One phone's slow radio must not block the agent. A subscriber that stays backed
up past 200 events is dropped with a reason telling it to reconnect. The ring
still holds everything, so **dropping it costs a reconnect, not data** — the
alternative trades a correctness property for a convenience one.

## Acknowledgement means delivered

A POST returns success **only once the turn has actually reached the session**.
ADR-0007 §3b makes injection acknowledged; acknowledging optimistically here
would quietly undo that. If the session refuses the text, the device gets a 502
and is not told it landed.

Attribution is written **before** delivery and awaited (invariant 4) — a failure
to record is a failure to send.

## Idempotency, because a duplicated instruction is not a duplicated packet

Every message carries a client-generated `messageId`. A retry after a dropped
connection returns `status: "duplicate"` with the original `seq` **without
delivering again**. This matters more than it looks: replaying a TCP segment is
free, and replaying an instruction to an agent is not.

## Bounds are stated, not silent

A message over 32,000 characters is refused with a 413 naming the limit — *a
silently shortened instruction to an agent is worse than a refused one.* The
server's own body cap sits well above it (128 KiB) so the handler's limit is the
one that speaks; two limits that disagree mean the smaller one wins silently and
the caller is refused by a layer that never announced a limit.

## Related

[[Hosted Session]] · [[Device Authentication]] · [[Autonomy Gate]] ·
[[Blocked State Read Model]]
