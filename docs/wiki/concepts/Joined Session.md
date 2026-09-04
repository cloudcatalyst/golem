---
title: Joined Session
type: concept
tags: [r13, adr-0007, remote, companion-app, proxy, session, injection]
sources: [docs/decisions/ADR-0007-remote-conversation-and-hosted-sessions.md, docs/plan/tasks/R13.7.md, docs/plan/verification-notes.md, src/session/join-queue.ts, src/session/live-conversations.ts, src/pipeline/join-injection.ts]
created: 2026-09-03
updated: 2026-09-03
---

# Joined Session

A **joined** session is one you are already running yourself — Claude Code in a
terminal, or any other harness pointed at Golem's proxy. Golem did not start it
and does not own it. A paired device can still speak into it: the message waits,
and Golem delivers it as a clearly-marked block on that conversation's **next
request**.

That is the whole mechanism, and the sentence to hold on to is the second one.
Contrast [[Hosted Session]], which Golem starts and supervises, and can therefore
answer immediately.

## Sent means QUEUED, not delivered

This is the misunderstanding the feature generates, so it is stated first.

The proxy sits *below* the harness. It sees a request when the harness makes one
and is silent otherwise — it cannot poke a program that is not talking to it. So:

| the session is… | when your message lands |
|---|---|
| running a turn or looping through tools | on its next request — usually seconds |
| sitting at an idle prompt | **never, until you go and use it** |

The device says which of those applies rather than showing a checkmark and
hoping. A queued message answers `queued` with a condition in plain words —
*"this session is idle (14 minutes since its last request); nothing will be
delivered until it runs again"* — and offers the alternative, which is to start a
[[Hosted Session]] that Golem can actually drive.

If you want a message acted on *now*, a joined session is the wrong tool. That is
not a defect to be fixed later; it is what "the proxy is below the harness"
means.

## What lands, and what the model sees

The message is appended as its own `user` turn, fenced so it is visible in any
captured request:

```
<golem-remote-message v="1" device="pixel-7" at="2026-09-03T09:14:22.101Z" id="a3f1">
also update the changelog
</golem-remote-message>
```

with a preamble saying that it came from your own paired device rather than the
terminal, that it is a request rather than a system instruction, and that every
tool call it leads to is gated exactly as if you had typed it. That last clause
is ADR-0007's central claim: **text is not authority**. Nothing about a message
arriving from a phone makes the resulting work more permitted — or less. See
[[Autonomy Gate]].

Appending a turn (rather than editing the last message) leaves every earlier
message byte-for-byte unchanged, so the prompt cache keeps its prefix; the only
new bytes are the tail. Consecutive `user` messages are legal — the API combines
them — which is what makes that possible (verification-notes §148).

## Exactly once, or not at all

A queued message carries an id you send with it. Re-sending after a dropped
connection returns `duplicate` rather than queueing a second copy, and delivery
itself is a cross-process claim: whichever reader wins creates the delivered
record, and every other reader is refused. **A duplicated instruction to an agent
is not a duplicated packet** — so the queue is built to occasionally lose a
message (you can re-send it) and never to deliver one twice.

A message that has waited more than 12 hours is **expired** instead of delivered.
An instruction written this morning, landing when the session finally loops
tomorrow, is exactly the surprise this design refuses.

## Which conversations can be addressed

Golem identifies a conversation by a hash of its first message — the same
identity the [[Conversation Store]] and the session tree use. Two conversations
that open with an identical first message therefore share a key, and Golem
**refuses both** rather than guessing which one you meant. The device shows such
a conversation marked `AMBIGUOUS — not addressable`; it becomes addressable again
once one of the two has been idle for half an hour. Anything the proxy has not
seen recently is refused for the same reason: silence denies.

## Turning it on, and seeing what happened

Off by default. With it off, nothing is injected and the request Golem forwards
is byte-identical to what your harness sent — the pipeline is not handed a queue
at all, so there is no code to run.

```
security.join_injection = true      # let a device's message land in a running session
golem session pending               # what is waiting, what landed, what can be addressed
golem session drop <messageId>      # bin a waiting message before it is ever delivered
```

Sending still requires everything [[Device Authentication]] requires: a paired
device presenting its client certificate, and a live unlock window. What the
setting changes is only whether an accepted message may reach a session you are
typing into, rather than only one Golem hosts. Every delivery is recorded and
shown locally *before* it lands — you can always see what your own phone said
into your session.

The wire it travels on is [[Session Transport]].
