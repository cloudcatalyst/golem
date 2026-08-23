---
title: Conversation Store
type: concept
tags: [session, storage, redaction, retention, adr-0007, r13.2]
sources: [src/session/conversation-store.ts, src/interfaces/conversation-store.ts, src/cli/commands/session.ts, docs/decisions/ADR-0007-remote-conversation-and-hosted-sessions.md, docs/plan/verification-notes.md#143]
created: 2026-08-22
updated: 2026-08-22
---

# Conversation Store

What Golem keeps on disk when it records a conversation's turns — plainly,
because "everything you said to the agent" deserves a sentence, not a buried
default. Built for task R13.2, under ADR-0007 §6 (Retention).

## What is stored, and where

One JSON file per conversation, at:

```
<project-root>/.golem/conversations/<conversationId>.json
```

`<project-root>` collapses a git linked worktree to its main checkout first
(`resolveWorktreeRoot`, task `ccr-ref-scope`), so a conversation started from
inside a worktree lands in the same place a main-checkout reader looks. Each
file holds `conversationId`, `startedAt`, `lastTurnAt`, and the list of turns
(`role`, `content`, `timestamp`) — written mode `0o600` (owner-only, where the
platform honours file modes; a no-op on Windows).

**Every turn's content is redacted before it is ever written.** `appendTurn`
runs the same [[Redaction Stage]] the proxy runs before anything reaches an
upstream model — unconditionally, with no flag or branch that skips it. A
secret placed in a turn is stored as `[REDACTED:...]`, never as itself; this is
proven with a runtime-generated secret in `tests/unit/session/conversation-store.test.ts`,
not merely asserted in a comment.

## What is NOT stored here

`src/session/session-tree.ts` (the branch/fork recorder, see
`debriefs/2026-08-03-r8.s3-session-tree.md`) records **content hashes only,
never prompt content** — deliberately, and that did not change. This store is
a second, separate one sitting beside it, added because two features need real
turn text on disk that a hash cannot provide: scrollback (seeing the previous
messages again) and continuing a conversation later. ADR-0007 Revision 1
dropped branching, so this store is *not* an indefinite archive — it is sized
for those two purposes only (see Bounds, below).

Nothing here is sent anywhere. It is not indexed into the vector knowledge
base — a searchable archive of every conversation is a larger privacy decision
than ADR-0007 made.

## How long it's kept

Bounded two ways, both configurable, oldest evicted first:

- **Count** — 32 conversations by default.
- **Age** — 30 days by default.

Eviction runs after every append (age first, then count). The default numbers
follow [[Web Cache]]'s precedent for a bounded local store under `.golem/`:
generous enough to be useful, small enough that "how much of my history does
this hold" has an honest, boring answer.

## How to delete it

- **One conversation**: `golem session forget <conversationId>`
- **Everything**: `golem session forget --all`

Both go through the real store (not a stub) and are covered by CLI-level
tests (`tests/unit/cli/session-forget.test.ts`) exercising the actual
`LocalConversationStore`, not a mock. `--all` recreates an empty directory
immediately, so recording can resume right away.

Deleting the whole `.golem/` directory manually also removes it — the store
keeps no state outside `.golem/conversations/`.

## Never in git

`.golem/conversations/` is listed explicitly in `.gitignore` (this repo lists
every `.golem/` subdirectory by name rather than trusting one blanket
pattern), verified with a test that shells out to `git check-ignore` against
the real repository rather than assuming the pattern applies, plus a second
test asserting `git ls-files .golem/conversations` returns nothing — a fresh
clone carries no store.

## Identity

A conversation's id is `cachePrefixFingerprint(requestBody).conversationKey`
(`src/proxy/cache-prefix.ts`, fixed by task R8.13) — the exact function
`session-tree.ts` already uses for its own conversation key. This store does
not derive a second identity of its own: one conversation, one id, agreeing
across both stores.

## The frozen contract

`src/interfaces/conversation-store.ts` defines `ConversationStore`: append a
turn, read a conversation, list conversations, forget one — a frozen contract
(`src/interfaces/` changes need a flagged PR). Consumers queued to build on it:
the session host (R13.3), the transport (R13.5), and continue/start flows
(R13.8).

See [[Architecture]] for where this sits in the whole request path, and
[[Redaction Stage]] for the redaction floor every storage path in Golem
shares.
