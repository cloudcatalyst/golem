---
title: Status surfaces gate on `.golem/` — no folder in non-Golem projects; "Passthrough" for the off state
type: debrief
tags: [statusline, vscode-extension, local-model, passthrough, dogfooding, decision-30]
sources: [src/cli/local-model.ts, src/cli/statusline.ts, vscode-extension/extension.js, vscode-extension/render.js]
created: 2026-07-23
updated: 2026-07-23
---

# Status surfaces gate on `.golem/`; "Passthrough" for the off state

Two user-reported UX fixes to how Golem surfaces its state (PR #20, PR #25).

## The durable principle

**Golem's status surfaces run in EVERY Claude Code project, not just Golem
ones.** The terminal status line (`golem statusline`) can be registered as a
*global* Claude Code `statusLine`, and the VS Code extension installs into VS
Code's *global* extensions dir (`golem init` step 7) — so both activate in
every window the user opens, including repos that never ran `golem init`.

Consequence, and the rule to keep: **a surface that runs everywhere must not
leave a footprint in a project that never opted in.**

- **Best-effort writers must never bootstrap `.golem/`.** They write only into
  an *already-existing* `.golem/`, never create one. See
  `golemDirExists()` in `src/cli/local-model.ts`.
- **UI hides itself in non-Golem projects.** The VS Code status bar is shown
  (and the CLI spawned) only when `.golem/settings.json` exists — the `golem
  init` marker, re-checked each poll.

## Part 1 — the `.golem/` leak (PR #20)

`golem statusline` runs every turn. Its local-model reachability cache writer
did `mkdir(.golem/state, { recursive: true })`, which **created a `.golem/`
folder in any repo the (global) status line touched** — littering unrelated
projects with `.golem/state/local-model.json`.

Fix: `writeLocalModelCache` is a no-op unless `.golem/` already exists, and
`collectGolemState` skips the local-model probe entirely for non-Golem projects
(which also drops a wasted per-turn localhost round-trip). `.golem/settings.json`
is the true opt-in marker — `golem init` writes it and uses it as its own
installed-check.

## Part 2 — "Passthrough" label + extension gating (PR #25)

**"Passthrough" for the off state**, on both the terminal line and the VS Code
status bar. It collapses the two "Golem isn't transforming your traffic" cases
into one label: the proxy is stopped, **or** it's running at slider **level 0**
(full bypass — see [[Slider Levels]], Decision 30). Both render
`Passthrough → [local + ]<upstream>`. Changes from before:

- Dropped the old `proxy off` text and the rule that *hid* the upstream when
  stopped — the destination is now shown in every state as the configured
  target. A hollow glyph (⬡) still marks a stopped proxy; filled (⬢) marks it
  running. `local +` folds in whenever a local model is reachable, at any level.
- **VS Code status bar hidden in non-Golem projects** (see the principle above).
  Visibility is re-evaluated on each poll, so the bar appears/disappears as you
  switch workspaces or run `golem init`.
- Corrected `vscode-extension/README.md`: the status bar is a compact,
  provider-focused line, **not** the verbatim `golem statusline` output (the two
  renderers deliberately differ — savings live in the bar's tooltip/panel).

## Notes

- Existing repos already polluted with a stray `.golem/` are not auto-cleaned;
  they can be deleted and won't return.
- Both changes were drafted with the `coder` tool first per the local-coder
  practice — the local draft got the shape but dropped `mkdir`/glyph/badge
  handling, so the value was in the review half again (cf. [[Dogfooding Golem]]).
- CI note: PR #25 was admin-merged because GitHub Actions refused to start all
  jobs (account billing block), not on a red test run — local `tsc`/lint/format/
  vitest/extension `node --test` were all green.

## Interfaces

No frozen `src/interfaces/` change. `GolemState` (non-frozen) is unchanged; the
new `updateAvailable` field it carries arrived earlier with Decision 41's
self-update surfacing.
