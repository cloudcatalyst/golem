---
title: Autonomy Gate
type: concept
tags: [autonomy, hooks, permission, adr-0002, adr-0006, safety]
sources: ["docs/decisions/ADR-0002-autonomy-approval-gates.md", "docs/decisions/ADR-0006-remote-steering-and-the-companion-app.md", "https://code.claude.com/docs/en/hooks", "docs/plan/verification-notes.md §141"]
updated: 2026-08-28
created: 2026-08-28
---

# Autonomy Gate

Golem's approval gate: a per-project autonomy **level** crossed with a per-call
action **class**, enforced through two Claude Code hooks. Threat model and the
default-deny proofs are `docs/decisions/ADR-0002-autonomy-approval-gates.md`.

## The two axes

**Action class** (`src/autonomy/classify.ts`) — `read`, `write`, `destructive`,
`outward`, `unknown`. Classification is per tool call, and for `Bash` it reads
the command.

**Autonomy level** (`src/autonomy/policy.ts`, stored in
`.golem/state/autonomy.json`) — `manual` (default), `assisted`, `outcome`.

| level | read | write | unknown | destructive / outward |
|---|---|---|---|---|
| `manual` | native prompt | native prompt | native prompt | **never auto** |
| `assisted` | auto-allow | native prompt | native prompt | **never auto** |
| `outcome` | auto-allow | auto-allow | forced ask | **never auto** |

The never-auto column is the invariant: **no autonomy level auto-approves a
destructive or outward action.** `allow` is the only value that removes a
prompt, and it is emitted narrowly.

## The two hooks (R12.12)

The gate is **two** hooks, wired and unwired together. Installing one without
the other is a half-installed gate.

1. **`PreToolUse`** (`src/hooks/pre-tool-use.ts`) — runs on every tool call.
   Classifies, writes the audit log (`appendActionLog`) and the pending-call
   record (`recordPending`), and emits `allow` / `ask` / nothing. Also carries
   the [[Usage Limit Park]], the [[Spawn Headroom Gate]] and the coder-first
   nudge, which is why it fires even when the gate itself is disabled.

2. **`PermissionRequest`** (`src/hooks/permission-request.ts`) — runs only when
   Claude Code is about to ask for permission. Returns a real `deny` for
   `destructive` / `outward`; defers on everything else. Writes nothing.

### Why the second one exists

`ask` forces a question; it does not answer one. A permission dialog — once it
exists — is what a connected permission-relay channel is notified of, so an
`ask` on `rm -rf` was relayable like any other prompt (R12.11,
`docs/plan/verification-notes.md` §141). A `PermissionRequest` decision stands
in for the dialog, so no dialog is shown and there is nothing to relay. See
[[R12.12 -- the gate moved one event earlier, where a decision can actually resolve the request]].

### The shapes are not interchangeable

| event | field | reason field |
|---|---|---|
| `PreToolUse` | `hookSpecificOutput.permissionDecision` (flat) | `permissionDecisionReason` |
| `PermissionRequest` | `hookSpecificOutput.decision.behavior` (nested) | `message`, deny only |

Emitting the wrong shape is a **silent no-op** — no error anywhere.

## Fail-safe discipline

Every failure path in both hooks exits 0 with **no stdout**: unparseable input,
a missing project, a config read that throws. No decision means the native
permission flow — the human — governs. **No path ever emits `allow` on error.**
Neither hook uses exit 2, which would hard-block.

Deferring at `PermissionRequest` is byte-for-byte what a project with no such
hook registered already does, which is why adding the layer changed nothing for
the classes it does not act on.

## Controls

```
golem autonomy show              # level + whether the gate is enabled
golem autonomy set <level>       # manual | assisted | outcome
golem autonomy enable|disable    # the gate toggle — keeps the nudges
golem autonomy wire|unwire       # install/remove BOTH hooks
golem autonomy log               # the decision audit trail
```

`golem autonomy disable` is a **separate toggle** from the hook wiring: it turns
the gate off at both events while leaving the snooze and coder-first nudges
running. `golem init` wires both hooks by default.

## Related

[[Blocked State Read Model]] · [[Usage Limit Park]] · [[Spawn Headroom Gate]] ·
[[Guidance Rules]] · [[Configuration Surfaces]]
