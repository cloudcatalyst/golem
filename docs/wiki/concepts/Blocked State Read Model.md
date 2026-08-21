---
title: Blocked State Read Model
type: concept
tags: [r12, companion-app, blocked-state, hooks, redaction, adr-0006, decision-21b, read-model]
sources: [src/hooks/session-state.ts, src/hooks/session-hooks.ts, src/hooks/tool-argument.ts, src/cli/blocked-view.ts, docs/decisions/ADR-0006-remote-steering-and-the-companion-app.md, docs/plan/tasks/R12.2.md, https://code.claude.com/docs/en/hooks]
created: 2026-08-21
updated: 2026-08-21
---

# Blocked State Read Model

What Golem knows, and can tell any renderer, about a Claude Code session that is
**waiting on the human**. Written by hooks, read by four surfaces, and — because
ADR-0006 §1 makes it a remote payload — redacted before it is ever written.

Shipped by R12.2. This page exists so the next author (R12.5's phone UI) reads the
model here rather than out of the TypeScript.

## Why a flag was not enough

Until R12.2 the state was `{ blocked, reason?, sessionId?, ts }`, and `reason` was
whatever string the `Notification` hook happened to receive. That is enough for a
dot on a status line. It is not enough for a human twenty minutes away deciding
whether to approve something:

> **"waiting on your input" is not an approvable question.**

Two facts make that worse than it sounds:

1. **Claude Code's notification never names the tool.** Verified 2026-08-21
   against https://code.claude.com/docs/en/hooks#notification — the docs' own
   example message is the entirely generic `"Claude needs your permission"`, with
   no `tool_name` and no `tool_input` in the payload. So no amount of parsing the
   message can answer "blocked on what".
2. **`blocked: false` and "nobody ever wrote again" looked identical.** The
   clearing hook is `UserPromptSubmit`. If the session dies mid-prompt it never
   fires, the flag stays `true` forever, and every renderer simply *hid* it once
   stale — displaying a dead block exactly like a healthy session.

## The model

Written to `<project>/.golem/state/session.json` by `src/hooks/session-state.ts`.
`v` is the shape version, so a reader can refuse a shape it does not know.

| field | answers | notes |
|---|---|---|
| `v` | — | `2`. A v1 file (no `v`) is upgraded on read, new fields absent |
| `blocked` | is it waiting | the original flag, unchanged |
| `ts` | **since when** | ISO-8601, of the last state change |
| `project` | **which project** | `{ dir, name }` — a session id does not name a working tree |
| `sessionId` | **which session** | a phone may be watching more than one |
| `kind` | **what kind of block** | `permission` \| `question` \| `idle` |
| `tool` | **blocked on what** | `{ name, argument?, actionClass? }` — for a permission request |
| `reason` | the notification text | redacted, like everything else |
| `lastEvent` | why it last changed | `blocked` \| `responded` |

`kind` is mapped from Claude Code's `notification_type`, which is authoritative
where the client sends it: `permission_prompt` → `permission`, `idle_prompt` →
`idle`, `agent_needs_input` and the `elicitation_*` dialogs → `question`. Four
types are **not** blocks at all (`auth_success`, `elicitation_complete`,
`elicitation_response`, `agent_completed`) and no longer light up an indicator —
before R12.2 every notification set `blocked: true`, so a login confirmation alone
could show "waiting" with nothing waiting.

### Four statuses, not one boolean

`resolveBlock(state, now)` is the shared classifier. Every renderer calls it
instead of re-deriving staleness, which is how the dashboard and the status line
came to disagree in the first place.

| status | meaning |
|---|---|
| `waiting` | blocked, and fresh (`< BLOCKED_STALE_MS`, 10 min). Someone is being asked something |
| `abandoned` | blocked, but stale: **nobody ever wrote again.** The session died mid-prompt, or moved on without the clearing hook firing |
| `clear` | a writer explicitly recorded that the human responded (`lastEvent: "responded"`) |
| `unknown` | no readable state at all. **Not** the same as `clear` |

That is the answer to "what happens when the session dies mid-prompt": the block
becomes `abandoned`, visibly, with its age. Golem does **not** wire a `SessionEnd`
hook to clean it up — a stale block that says so is more honest than one silently
erased, and it needs no new event surface.

### Where the tool and argument come from

Not from the notification. `src/hooks/pre-tool-use.ts` records a **pending tool
call** to `.golem/state/pending-tool.json` at the moment a call is about to face
the human, and the `Notification` handler correlates the two.

- Recorded when the autonomy gate emits anything other than `allow` — a deferral
  (native prompt) or a forced `ask`. An auto-`allow` is answered without the
  human, so recording it would overwrite the real question with noise. A snooze
  park or coder-first `deny` is a refusal, not a question, and is also skipped.
- Correlation requires the same session and an age under
  `PENDING_TOOL_MAX_AGE_MS` (2 min) — generous against the documented ~6 s
  permission-prompt delay, tight enough that a previous answered call cannot
  attach itself to a new block.
- Attached **only** to a `permission` block. For an idle turn there is no call
  under judgement, and naming the last one would invent a question the human was
  never asked.
- `actionClass` is ADR-0002's `classifyAction` result, carried because ADR-0006 §2
  makes it the field that decides whether a remote device may answer at all —
  `destructive` and `outward` wait for the laptop. R12.2 only records it.

`toolArgument()` (`src/hooks/tool-argument.ts`) picks the one field a human must
judge — `command` for Bash, `file_path` for an edit, `url` for a fetch — verbatim,
never summarised, because ADR-0006 §2 requires full text for the `unknown` class
that a phone may actually approve. Capped at 2 000 chars with a visible
`…[truncated]` marker.

## Redaction is unconditional

See [[Redaction Stage]] for the rules themselves. What is specific here:

- This is the **first Golem-written artefact whose purpose is to carry a verbatim
  tool argument**, and ADR-0006 §1 makes it a remote payload: "everything in it is
  redacted before it is written … Same rule as everything else, no new exception."
- The choke point is `writeSessionState` / `writePendingToolCall`, not the callers.
  A recursive walk redacts **every string in the record**, so a field added to the
  model later is covered without anyone remembering to redact it.
- Applied to raw values, not to the serialized JSON: a secret containing a quote
  would appear escaped in JSON text and could slip a pattern.
- **Fail closed.** If the redaction stage cannot be loaded, nothing is written.
  There is no unredacted fallback and no setting that produces one.
- The stage is imported *lazily*, because `session-state.ts` sits on the
  per-prompt status-line read path and the read half must not pay for the
  compression graph.

**Known consequence, accepted:** the sweep applies to `project.dir` too, so a
high-entropy directory segment (a git worktree named `agent-ad466baadab001983`, for
instance) can land as a placeholder. The alternative was an exception to the
redaction rule, and there isn't one. ADR-0006 already states that redaction makes
the payload safe to *transmit*, not safe to *publish*: a redacted argument still
discloses file paths and what the developer is working on to whoever holds the
device.

## The renderers

One model, four surfaces. `blockedView()` (`src/cli/blocked-view.ts`) is the single
snake_case projection both JSON surfaces use, so they cannot drift.

| surface | reads | shows |
|---|---|---|
| `golem statusline` | the file directly | `⏸ waiting: Bash`, or `⏸ waiting (idle)`. `waiting` only |
| VS Code status bar | `golem status --json` → `blocked` | the same string, byte for byte |
| VS Code panel | the same | a banner with the argument, `waiting` and `abandoned` |
| dashboard | page + `/api/state` | the same banner, and the full report |

The two status lines are pinned to each other by
`tests/unit/cli/statusline-parity.test.ts`. R12.2 added fixtures at the blocked
states, which is the interesting part: `golem statusline` had printed `⏸ waiting`
since Decision 21b while the VS Code status bar an inch away printed **nothing**,
and the parity test never noticed because no fixture visited a blocked state. The
lesson from R11.8 — *a parity test only pins the states its fixtures visit* — cost
a second surface before it was applied here.

## What this deliberately is not

No network listener, no binding beyond `127.0.0.1`, no write path, no approve
button. R12.2 ships value with no remote channel at all: a better local indicator,
and a contract the guarded step can be built against. Serving it to a device is
R12.3/R12.4 under ADR-0006's mTLS pairing; the phone UI is R12.5.

## See also

- [[Redaction Stage]] — the rules every string here passes through
- [[Architecture]] — where the hooks sit in the PreToolUse guardrail stack
- [[Configuration Surfaces]] — the other thing every renderer must agree about
- `docs/decisions/ADR-0006-remote-steering-and-the-companion-app.md` — §1
  (observe ships first, everything redacted before it is written) and §2 (which
  action classes a remote device may ever answer)
- `docs/decisions/ADR-0002-autonomy-approval-gates.md` — where `actionClass`
  comes from
