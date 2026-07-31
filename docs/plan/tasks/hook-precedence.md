---
task: hook-precedence
title: Assert PreToolUse precedence between a rewriting hook and a denying hook (§91, still open)
state: done
owner: agent
size: S
design: docs/plan/verification-notes.md §91, §96
gate: A test that proves Golem's `deny` still wins when another hook returns `updatedInput` on the same Bash call. Do not trust the docs — they do not say.
depends_on: []
touches: [src/hooks/, tests/integration/]
created: 2026-07-30
updated: 2026-07-31T00:11:59.672Z
---

## Goal

Prove — not assume — what happens when two PreToolUse hooks disagree on the same tool
call: one rewriting the input, one denying it.

## Why this is open and why it matters

§91 checked the live docs (2026-07-30, `code.claude.com/docs/en/hooks`) and established
that PreToolUse hooks run **in parallel**, entries **merge** across settings levels,
`permissionDecision` is `allow|deny|ask|defer`, and `updatedInput` under
`hookSpecificOutput` **replaces a tool's arguments before it runs**.

What the docs do **not** state is the precedence when parallel hooks return conflicting
decisions — e.g. RTK returning `updatedInput` to rewrite a Bash command while Golem's
hook returns `deny` for snooze, coder-first, or autonomy.

This is live for anyone who installs both: Golem's PreToolUse is registered with **no
matcher** (`src/cli/init.ts`), so it fires on every Bash call.

§96 already found one real consequence of the same coexistence — RTK's rewrite made
Golem's start-anchored **allow**-list miss `rtk vitest`, so safe commands fell through
to a prompt. That was fail-closed and was fixed. This task is the other half: the case
where Golem needs its **deny** to win.

## Why a test and not more reading

Because the docs don't say, and the failure mode is a safety mechanism silently not
firing. §91's own instruction: **assert it; do not trust it.**

## Out of scope

Fixing Claude Code. Changing Golem's deny paths on the basis of a guess. Removing the
no-matcher registration (each stage self-filters by design).

## Outcome

Closed on both halves (§105). The docs have since gained the precedence sentence (deny > defer > ask > allow); the case they still omit — a hook returning ONLY updatedInput racing a deny — is now pinned by tests/e2e/hook-precedence.live.test.ts, an opt-in (GOLEM_LIVE_CLAUDE=1) live run against Claude Code 2.1.220. Two competing project-scope Bash hooks: both fired, the marker file was never created, so the deny won and the rewrite was discarded. Test fails rather than passing vacuously if neither hook fires.
