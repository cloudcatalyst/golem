---
title: Configuration Surfaces
type: concept
tags: [config, settings, tui, vscode, control-surface, toggle, ui]
sources: [src/config/ui-model.ts, src/config/control-surface.ts, src/config/schema.ts, src/tui/, vscode-extension/render.js]
created: 2026-07-30
updated: 2026-07-30
---

# Configuration Surfaces

How Golem's settings are described once and rendered everywhere: the `golem ui`
terminal panel, the `golem config` CLI, and the VS Code webview all read one
runtime-introspectable **control surface**.

## The problem this solves

Golem's user-facing state lives in three unrelated stores, each with its own
scopes and its own write path:

| Family | Store | Scopes | Owned by |
|---|---|---|---|
| **Settings** | `.golem/settings.json` (+ `GOLEM_*` env) | user · project · local · env | `writeSetting` ← [[Slider Levels]] etc. |
| **Guidance** | `.claude/rules/golem-<name>.md` — the file's *presence* is the toggle | project (committed) · user (`.local.md`) | [[Guidance Rules]] |
| **Runtime** | slider level, active account, proxy daemon up/down | each decides its own | `golem slider` / `account use` / `proxy` |

Layering was never the gap: precedence, provenance, atomic scoped writes, and env
overrides already worked (`src/config/loader.ts`). What was missing was
**presentation** — `schema.ts` holds zod validators and rich doc comments, but
comments are invisible at runtime, so any UI had to re-type every label. That is
why the VS Code panel could only ever expose the slider and the account.

## The two layers added

### 1. `src/config/ui-model.ts` — metadata beside the schema

`SETTINGS_LEAVES` is untouched. A sibling table carries the human-facing half:

- **`SETTING_META`** — `label` / `summary` / `detail`, plus `advanced`, `danger`,
  `restart`, and `ownedBy`, keyed by the same dotted `section.key` paths. It is
  annotated `satisfies { [P in LeafPath]: SettingMeta }`, where `LeafPath` is
  derived from `SETTINGS_LEAVES` — so **adding a settings key without describing
  it is a compile error**. The two tables cannot drift, and no sync test is needed.
- **`deriveKind`** — the widget kind comes from the leaf's zod schema
  (`ZodBoolean` → toggle, `ZodEnum` → picker, `.url()` → url, string array → list,
  array-of-objects → opaque), after unwrapping `.optional()` / `.default()` /
  `.transform()`. A type change therefore can't leave a stale widget behind.
  `SettingMeta.kind` overrides it only where zod can't express the intent — a hex
  colour is just a validated string.
- **`SECTION_META`** — title, summary, and display order per section.

`ownedBy` is the anti-duplication rule: `slider.level` and `proxy.active_account`
are omitted from the settings groups because a runtime control edits the same key
with a better affordance. Nothing is editable from two rows at once.

### 2. `src/config/control-surface.ts` — one list, three stores

`collectControlSurface()` flattens all three families into `Control` rows —
`id`, `kind`, `value`, `layer`/`source`, `writableScopes`, `locked`, `danger`,
`restart`, `advanced` — grouped into tabs, with the `golem status` report as the
header. `applyControl(id, value, scope)` routes writes back to the **existing**
implementations (`setConfig`, `writeGuidanceRule`, `setSliderLevel`, `useAccount`,
`startDetached`). It adds no persistence logic of its own, so a UI cannot bypass a
validation or a side effect the CLI performs.

Two rules every front end inherits:

- **Env-supplied controls are locked.** A value from the `env` layer is shown but
  refuses writes, with the reason — writing a file layer that env overrides would
  report success and change nothing.
- **`danger` needs a confirm.** Only in the risky direction: slider level 0 is the
  full bypass with redaction OFF (Decision 30), so *going to* 0 asks; coming back
  never does.

Control ids (`setting:<section>.<key>`, `guidance:<name>`, `runtime:<name>`) are a
stable contract — a webview round-trips them, so they must not change between
releases.

## The three front ends

```
                    src/config/ui-model.ts  (labels, kinds)
                              │
                    src/config/control-surface.ts
                    ├── collectControlSurface()  → read
                    └── applyControl()           → write
                              │
        ┌─────────────────────┼──────────────────────────┐
   golem ui (src/tui/)   golem config          VS Code webview
   ink + React           schema/get/set/unset  (via `config schema --json`)
```

`golem config schema --json` emits the whole surface, which is what makes the VS
Code side maintenance-free: a new settings key appears there with no extension
change and no version skew.

### `golem ui` — the terminal panel

Reached by `golem ui` / `golem settings`, or by a bare `golem` in a terminal.
Bare-`golem` is gated on no arguments **and** both stdin/stdout being a TTY, so
`golem --help`, a pipe, CI, hook invocations, and the daemon all keep printing
help. It is decided before `program.parseAsync` rather than with a root
`program.action()` — an action handler on the root makes commander report a typo'd
subcommand as "too many arguments" instead of "unknown command".

Layout: the purple block-character **pet** on the left, three lines of live state
beside it (from the same `collectStatus` that `golem status` prints), then tabs,
the control list, and a key-hint footer.

**Startup latency is a design constraint here, not an afterthought** (measured in
verification-notes §86). Three rules keep it honest:

- **`src/cli/main.ts` is a dependency-free shim.** It reads argv and dynamically
  imports exactly one of `../tui/index.js` or `./program.js` — because ESM hoists
  imports, so the routing decision cannot live in a module that statically imports
  either branch. A bare `golem` therefore never loads commander or any other
  command's dependencies (~790ms saved).
- **The panel pre-paints before ink exists.** `splashLines` writes the pet, the
  version, and the cwd with raw SGR — all free data — within ~80ms of process
  start, then erases those lines before ink renders. First *visible* feedback is
  ~15× faster than first *interactive* frame, and that is the number a user feels.
- **Nothing needed only for display is on the first-paint path.**
  `ControlSurface.header` is nullable and `collectHeader` imports `cli/status.js`
  lazily; the slider's read half lives in `cli/slider-read.ts` so displaying a level
  doesn't load the write path's `cli/init.js`; guidance is imported from
  `hooks/guidance.js` rather than the hooks barrel. Panel interactive went ~2.5–3s
  → ~1.15s, with the header filling in a moment later.

`tests/unit/tui-lazy-import.test.ts` enforces all of it, including that the config
barrel never re-exports the control surface — doing so once added ~400ms to
`golem hook pre-tool-use`, which runs on every Claude Code tool call.

The same investigation produced a rule worth applying beyond this feature: **a
barrel import is a hot-path liability.** `undici` is the heaviest leaf in the CLI
(~270ms) and was reaching per-tool-call code through `../proxy/index.js` for
functions that only read a JSON file. Narrowing those imports took
`hooks/pre-tool-use.js` from 352ms to 127ms and `cli/statusline.js` from 473ms to
142ms. `src/cli/fast-path.ts` then takes the hook events and the status line off
commander entirely — `golem hook post-tool-use` went ~765ms → ~129ms, `statusline`
~985ms → ~301ms (verification-notes §86b).

The remaining floor is ink itself (~890ms, spread across its dependency tree rather
than concentrated in one import), so going materially below ~1s would mean
replacing it.

Two further structural choices worth knowing:

- **`src/tui/state.ts` is a pure reducer.** `(state, event) → {state, effects}`.
  Every interaction rule lives there and is unit-tested with no ink, no terminal,
  and no filesystem; `app.tsx` only performs the effects it is handed. This is why
  `tests/unit/tui-state.test.ts` can cover the whole feel of the panel.
- **ink is loaded only through a dynamic import.** `golem hook pre-tool-use` runs
  on every Claude Code tool call, and the proxy/MCP daemons share the entry point,
  so a static import of ink + React + yoga-layout would tax all of them.
  `tests/unit/tui-lazy-import.test.ts` fails the build if that regresses.

`ui.color` is applied by setting `FORCE_COLOR` **before** ink is imported (chalk
decides its level at import time), which keeps every `Theme` field a real colour
string — ink's `<Text color>` rejects an explicit `undefined` under
`exactOptionalPropertyTypes`.

### The pet

Three rows of eight Unicode block elements, in `ui.pet_color` (default `#a78bfa`).

```
■▜▛▜▆▛▜▙
▝▜██▀███
▚▟█▛▚█▛▘
```

The leading glyph is U+25A0 BLACK SQUARE, whose East Asian Width is
**Ambiguous** — single-width in most terminals, double-width in a CJK-configured
one. The pet is therefore drawn in a fixed-width box, so a double-wide render can
shift that glyph without pushing the header text out of alignment. `ui.pet false`
(or `golem ui --no-pet`) turns it off, which is also the escape hatch for legacy
Windows consoles on codepage 437/850, where the block glyphs can't be drawn.

### VS Code

The existing sidebar webview gained a Settings section rendered by the pure
`settingsHtml()` in `vscode-extension/render.js` from
`golem config schema --json`. Writes post a generic `{type:"apply", id, value,
scope}` message back; `extension.js` routes it to the matching CLI command,
mirroring `applyControl`. Native `contributes.configuration` was deliberately not
used: it would need the key list regenerated on every schema change, and VS Code's
settings scopes don't map onto user/project/local.

## The `ui` settings section

`ui.pet` · `ui.pet_color` · `ui.color` (`auto`/`always`/`never`) · `ui.advanced`.
Additive, so `GOLEM_UI_*` env overrides and `golem config set ui.pet false` came
for free.

## Related

[[Guidance Rules]] · [[Slider Levels]] · [[Architecture]] · [[Dogfooding Golem]]
