---
title: Autonomy gate decoupled from the shared PreToolUse hook
type: debrief
tags: [autonomy, pre-tool-use, snooze, adr-0002, decision-40, permissions]
sources: [docs/golem-spec.md, docs/wiki/decisions/ADR-0002-autonomy-approval-gates.md, src/autonomy/policy.ts]
created: 2026-07-22
updated: 2026-07-22
---

# Autonomy gate decoupled from the shared PreToolUse hook

Shipped **spec Decision 40**. Fixes a regression the user caught live: after the
snooze activation, git/network commands started prompting for approval every
time, even though `Bash` was allow-listed.

## The bug

`golem init` (as of the snooze activation, #16) wires ONE PreToolUse hook —
`golem hook pre-tool-use` — and that single hook runs three stages: the snooze
document-and-hold nudge (Decision 38), the coder-first enforcement (Decision
39), and the **R5.4 autonomy gate** ([[Guidance Rules]] / ADR-0002).

The autonomy gate forces an `ask` for `outward`/`destructive` actions at *every*
level — including the default `manual` — because `decideGate` checks
outward/destructive **before** the level switch. And a hook `ask` overrides the
user's own allow-list by design (ADR-0002). So wiring the hook for **snooze**
silently turned on the gate's outward-asking: every `git push` / `gh` / `curl`
prompted. The pre-existing opt-in had been "wire the hook"; snooze broke that
assumption by wiring it for everyone by default.

Confirmed from `.golem/state/autonomy-log.jsonl`:
`{"tool":"Bash","action":"outward","level":"manual","decision":"ask"}`.

## The fix ("opt-in but opted in by default")

A separate `enabled` flag on the autonomy state (`.golem/state/autonomy.json`),
distinct from the hook wiring:

- **ON by default** — a fresh project keeps the ADR-0002 safety gate.
- **Fail-closed** — missing / corrupt / `enabled` absent → ON; only an explicit
  `"enabled": false` disables (mirrors the level's fail-closed-to-`manual`).
- **`golem autonomy disable`** turns the *whole* gate off while the snooze +
  coder-first nudges keep running (they run before the gate in the hook);
  **`enable`** restores it. Surfaced loudly in `golem autonomy show` — a
  deliberate opt-out, like slider level 0 (Decision 30).

The `pre-tool-use` hook now consults the gate only when enabled; the two nudges
are unconditional. Also fixed the misleading `init` comment that claimed the
gate is "silent at the default `manual` level" (it is not, for
outward/destructive), and amended ADR-0002 with a dated note.

## Invariant preserved

ADR-0002's core invariant is unchanged **while the gate is enabled**: no level
auto-approves outward/destructive. Disabling is a whole-gate opt-out (Golem adds
no prompts; Claude Code's own allow-list + native prompts govern), not a
per-level loosening.

## Interfaces

No frozen `src/interfaces/` change; new non-frozen `AutonomyState`,
`readAutonomyState`, `readAutonomyGateEnabled`, `setAutonomyGateEnabled`,
`DEFAULT_AUTONOMY_GATE_ENABLED`; `PreToolUseGateOptions` gains a `readGateEnabled`
seam.
