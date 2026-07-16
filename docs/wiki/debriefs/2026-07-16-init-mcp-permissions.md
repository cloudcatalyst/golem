---
title: golem init pre-approves Golem's MCP tools
type: debrief
tags: [init, permissions, mcp, r4-followup]
sources: [src/cli/init.ts, https://code.claude.com/docs/en/permissions]
created: 2026-07-15
updated: 2026-07-15
---

Post-R4 follow-up from user feedback: Golem's MCP tools (and WebFetch) were
prompting on first use even though `.claude/settings.json` had a bare
`mcp__golem` allow rule.

## Root cause (verified against the Claude Code permissions docs)
The docs (code.claude.com/docs/en/permissions, "MCP" section) confirm
`mcp__golem` *does* match all tools from the server, and `mcp__golem__*` is a
valid anchored allow glob; only *unanchored* globs (`*`, `mcp__*`) are rejected
for allow rules. So the bare rule wasn't the problem — **`golem init` never
wrote any permission rule at all**; the entries in this repo were ad hoc. A
fresh `golem init` project therefore prompted on every Golem tool. (Note: allow
rules in a committed `.claude/settings.json` also require the one-time Claude
Code workspace-trust accept to activate — a likely contributor to the observed
prompts. `.claude/settings.local.json` rules skip that gate, at the cost of
being per-developer.)

Retrieving the exact MCP doc lines itself surfaced a real bug: Golem's webcache
served a 4–6-day-old, truncated capture of the docs page and never revalidated,
so the answer was stale until a cache-busting query param forced a fresh fetch.
Filed as a BACKLOG task (webcache freshness check: conditional requests via
ETag/Last-Modified, honor Cache-Control).

## What landed (`src/cli/init.ts`)
- `golem init` now merges into `.claude/settings.json`: `permissions.allow +=
  "mcp__golem__*"` (covers every current/future Golem tool) and
  `permissions.ask += "mcp__golem__wiki_upsert"` (writes stay gated — `ask`
  beats `allow`). Idempotent (reports "skip" on re-run); preserves unrelated
  permission rules (merge, not replace).
- `golem uninit` removes exactly those two rules and cleans an emptied
  `permissions` object.
- This project's own `.claude/settings.json` reconciled to the same scheme
  (dropped the nine hand-added explicit rules for the one glob + ask).

## Verification
`tsc`/lint/format clean; `npx vitest run` 923 green (+1: init writes the rules /
uninit removes them; updated the preserve-unrelated-keys test to expect the
merge). E2E: fresh `golem init` → `{allow:["mcp__golem__*"],ask:["mcp__golem__wiki_upsert"]}`,
re-run skips, `uninit` → permissions undefined. See [[Dogfooding Golem]].

