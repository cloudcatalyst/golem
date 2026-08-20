---
title: Status surfaces gate on `.golem/` — no folder in non-Golem projects; "Passthrough" for the off state
type: debrief
tags: [statusline, vscode-extension, local-model, update-check, passthrough, dogfooding, decision-30]
sources: [src/cli/local-model.ts, src/cli/statusline.ts, src/cli/main.ts, src/update/index.ts, vscode-extension/extension.js, vscode-extension/render.js]
created: 2026-07-23
updated: 2026-07-23
---

# Status surfaces gate on `.golem/`; "Passthrough" for the off state

User-reported UX fixes to how Golem surfaces its state (PR #20, PR #25, PR #27).

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
(full bypass — see [[Compression Levels]], Decision 30). Both render
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

## Part 3 — the update-check leak, same principle (PR #27)

The self-update feature (Decision 41, see
debriefs/2026-07-22-decision-41-distribution.md) added a **second** automatic
writer that the Part 1 fix didn't cover. `golem update --check` caches its
verdict to `<dir>/.golem/state/update-check.json`, and the VS Code extension
polls it in **every** window (installs globally) — on activation and every 6h —
so `.golem/` reappeared in non-Golem repos, this time as `update-check.json`.

Fix, mirroring Part 1:

- `golem update` (`src/cli/main.ts`) passes a project `cacheDir` only when
  `.golem/` already exists; otherwise it runs the check without caching
  (`checkForUpdate`/`writeCache` in `src/update/index.ts` only write when a
  `cacheDir` is given, so omitting it creates nothing).
- The extension's `fetchUpdate()` is a no-op in non-Golem projects — the same
  `isGolemProject()` gate `refresh()` already used, so it spawns **no** CLI in
  unrelated windows.

**Full audit done here:** every `<project>/.golem/` writer in `src/` was
checked. Only two fire *automatically* in every project — the local-model cache
(Part 1) and this update-check cache (Part 3). All others run only via
`golem init`, the proxy pipeline, init-wired hooks, or an explicit `golem <cmd>`
run *in* that project. An explicit command creating `.golem/` is a deliberate
opt-in, not a background surprise, and is left as-is — the rule targets surfaces
that run **without** the user asking.

## Notes

- Existing repos already polluted with a stray `.golem/` are not auto-cleaned;
  they can be deleted and won't return.
- Both changes were drafted with the `coder` tool first per the local-coder
  practice — the local draft got the shape but dropped `mkdir`/glyph/badge
  handling, so the value was in the review half again (cf. [[Dogfooding Golem]]).
- CI note: PR #25 and #27 were admin-merged because GitHub Actions refused to
  start any jobs (account billing block), not on a red test run — local
  `tsc`/lint/format/vitest/extension `node --test` were all green.

## Interfaces

No frozen `src/interfaces/` change. `GolemState` (non-frozen) is unchanged; the
new `updateAvailable` field it carries arrived earlier with Decision 41's
self-update surfacing.
