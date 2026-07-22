---
title: Coder-first enforcement — soft guidance becomes a PreToolUse gate
type: debrief
tags: [coder, guidance, autonomy, pre-tool-use, enforcement, decision-39]
sources: [docs/golem-spec.md, src/hooks/coder-first-nudge.ts, src/hooks/guidance.ts]
created: 2026-07-22
updated: 2026-07-22
---

# Coder-first enforcement — soft guidance becomes a PreToolUse gate

Shipped **spec Decision 39** (PR #18). Promotes the `local-coder` guidance
("draft non-trivial code with the `coder` MCP tool first") from advisory to an
enforced `PreToolUse` gate — the same soft-guidance→gate move [[Guidance Rules]]
saw for snooze (Decision 38, [[Golem snooze — park a live session until the limit resets]]).

## Why

Observed directly while building the snooze feature: the soft `local-coder`
rule kept losing to momentum. The agent wrote non-trivial code by hand without
drafting via `coder` first — not because the rule was unclear, but because a
soft rule with **no trigger tied to the action** relies on remembering to detour
mid-flow. This is the identical failure mode snooze fixed by becoming a gate;
the fix is the same shape. (Prompted by the user asking "why wasn't the local
coder used, does the guidance need to be more explicit?" — the honest answer:
explicitness helps at the margin, but the structural lever is a trigger.)

## What landed (two parts, per the user's "both, enforced if guided")

1. **Sharpened wording** (`LOCAL_CODER` snippet) — a concrete non-trivial
   threshold (≳240 chars of new code / any new function or module), explicit
   skip cases (one-liners, config/JSON/Markdown, `.d.ts`, lint/format fixes), a
   self-check ("if you didn't draft with `coder`, do so or say why — don't skip
   silently"), and a note that the gate now backs it.
2. **Enforcement** (`src/hooks/coder-first-nudge.ts` + `pre-tool-use.ts`) — the
   gate DENIES the *first* non-trivial hand-written code `Write`/`Edit` of a
   session and redirects to draft with `coder` first. **One-shot per session**
   (keyed by the hook payload's `session_id`; state in
   `.golem/state/coder-first-nudge.json`) so it's a single non-polluting
   redirect. Order in the gate: snooze document-and-hold → coder-first →
   autonomy gate (ADR-0002).

## "Enforced if guided"

`guidanceEnabled(projectDir, "local-coder")` gates the enforcement: presence of
the `.claude/rules/golem-local-coder.md` file *is* the toggle (the same
convention `golem guidance enable/disable` already uses). Disable the guidance
and the enforcement goes with it.

## Honest scope (what it is NOT)

The hook cannot see whether code was **already** drafted with `coder` — it only
sees the pending write. So this is an *interrupting reminder* (a `deny` that
bounces the instruction back to the agent), not a proof-of-drafting gate. The
deny reason explicitly tells an agent that already drafted to say so and
proceed, so it never loops or forces a re-draft. One-shot-per-session keeps it
from nagging.

## Dogfooding note

The `coder-first-nudge.ts` module was drafted with the `coder` tool first (the
very practice this PR enforces). The local model's first pass was unusable — it
stubbed the functions and used wrong field names — so the value came from the
review/rewrite half, which is exactly the split the guidance describes: the
local model drafts, the paid model does the judgment. See [[Dogfooding Golem]].

## Interfaces

No frozen `src/interfaces/` change; `PreToolUseGateOptions` (non-frozen) gains
an injectable `isGuidanceEnabled` seam for tests.
