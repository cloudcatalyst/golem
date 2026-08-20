---
title: Configuration Surfaces
type: concept
tags: [config, settings, tui, vscode, control-surface, toggle, ui]
sources: [src/config/ui-model.ts, src/config/control-surface.ts, src/config/schema.ts, src/tui/, vscode-extension/render.js]
created: 2026-07-30
updated: 2026-08-09
---

# Configuration Surfaces

How Golem's settings are described once and rendered everywhere: the `golem` terminal
panel, the `golem config` CLI, and the VS Code webview all read one
runtime-introspectable **control surface**.

## The problem this solves

Golem's user-facing state lives in three unrelated stores, each with its own
scopes and its own write path:

| Family | Store | Scopes | Owned by |
|---|---|---|---|
| **Settings** | `.golem/settings.json` (+ `GOLEM_*` env) | user · project · local · env | `writeSetting` ← [[Compression Levels]] etc. |
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
   golem (src/tui/)      golem config          VS Code webview
   self-rendered, no     schema/get/set/unset  (via `config schema --json`)
   framework
```

`golem config schema --json` emits the whole surface, which is what makes the VS
Code side maintenance-free: a new settings key appears there with no extension
change and no version skew.

### `golem` — the terminal panel

**There is no subcommand: `golem` on its own IS the panel** (Decision 51 removed
`golem ui` / `golem settings` and moved their flags onto the bare command, so the
panel has one entry point and gets the fast path instead of commander's ~810ms).
It accepts `--dir <path>`, `--no-pet`, and `--advanced`.

Routing lives in `src/cli/main.ts` (`parsePanelArgs`), and the accept/reject boundary
is deliberate: **any unrecognised flag falls through to commander**, so a mistyped
flag is reported by the code that owns flag parsing rather than silently opening a
UI. `--help`, `--version`, and every named command go to commander too. A bare
`golem` outside a terminal still prints help, which is what `golem | cat`, CI, and a
stray hook invocation get; panel *flags* outside a terminal say why they can't run.

It is decided before `program.parseAsync` rather than with a root `program.action()`
— an action handler on the root makes commander report a typo'd subcommand as "too
many arguments" instead of "unknown command". `golem --help` documents the panel in
an after-help block, since it has no subcommand to carry its options, and a test
asserts the documented flags and the accepted flags agree.

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
- **The view is a pure function.** `renderPanel(state) → string[]`, so layout is
  computed directly rather than by a flexbox engine, and the whole UI is assertable
  as strings. `screen.ts` then rewrites only the lines that changed.
- **Nothing needed only for display is on the first-paint path.**
  `ControlSurface.header` is nullable and `collectHeader` imports `cli/status.js`
  lazily; the slider's read half lives in `cli/slider-read.ts` so displaying a level
  doesn't load the write path's `cli/init.js`; guidance is imported from
  `hooks/guidance.js` rather than the hooks barrel. The header still arrives a beat
  after the first frame, into a same-height placeholder.

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

ink and React were subsequently **removed** (spec Decision 51): they were ~85% of the
panel's load and nothing in them could be deferred. `src/tui/` now renders itself —
`render.ts` (layout), `screen.ts` (diffed repaint), `keys.ts` (key decoding),
`ansi.ts` (colour degradation), `width.ts` (ANSI/wide-char measurement) — with the
same layout, keys, and colours, and `golem-run` back to 6 runtime dependencies.
**The panel now paints a fully-populated first frame in ~170ms**, so the pre-paint
splash was deleted too: there is nothing left to cover.

One further structural choice, and the one that made the ink removal cheap:

- **`src/tui/state.ts` is a pure reducer.** `(state, event) → {state, effects}`,
  where `KeyPress` was always an ink-agnostic shape. Every interaction rule lives
  there and is tested with no terminal and no filesystem — so
  `tests/unit/tui-state.test.ts` (32 tests) passed **unchanged** through the whole
  rewrite. Only the view changed. `index.ts` is a ~40-line dispatch loop that
  performs the effects the reducer hands it.

Colour is resolved by `ansi.ts` rather than by an environment variable: `ui.color`
maps to a `Theme.level` (0 = plain text, 1/2/3 = 16/256/24-bit), and every theme
colour is a hex triplet degraded to that level. That is simpler than the ink version,
which had to poke `FORCE_COLOR` before importing chalk because chalk fixes its level
at import time.

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
(or `golem --no-pet`) turns it off, which is also the escape hatch for legacy
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

## Object-valued settings and shell quoting (R9.9, 2026-08-09)

`golem config set` coerces the raw CLI string to the leaf's schema type: booleans
(`true/false/1/0/yes/no/on/off`), numbers, arrays (JSON, or comma-separated), and —
since R9.9 — **objects** (`z.record` / `z.object` leaves, parsed as JSON).

Before R9.9 the object branch was missing, so the string reached zod untouched and
failed with `Expected object, received string`. `compression.headroom_config` — the
Decision 53(h) passthrough bag — was therefore settable only by hand-editing
`.golem/settings.local.json`, which is exactly what `golem config` exists to avoid.

Semantics match the scalar and array paths: **set replaces the whole object**, it does
not deep-merge. `{}` clears it; `golem config unset <key>` removes it so lower layers
apply again. Errors name the cause — `invalid JSON for "<key>": …` for a parse failure,
`expects a JSON object, got array` for valid JSON of the wrong shape — rather than the
downstream zod symptom.

**Quoting differs per shell**, and a lost quoting fight looks like a JSON parse error:

| Shell | Invocation |
|---|---|
| PowerShell 7+ | `golem config set compression.headroom_config '{"protect_recent":6}' --scope local` |
| cmd.exe | `golem config set compression.headroom_config "{""protect_recent"":6}" --scope local` |
| bash / zsh | `golem config set compression.headroom_config '{"protect_recent":6}' --scope local` |

The escape hatch avoids the fight entirely — the value comes from a file, or stdin:

```
golem config set compression.headroom_config --value-file ./headroom.json --scope local
golem config set compression.headroom_config --value-file -   # value on stdin
```

Passing both a positional value and `--value-file` is an error, not a silent
preference for one of them.

## The `models` settings section (R8.8, 2026-07-31)

`models.catalog_url` · `models.catalog_max_age_days` · `models.context_warn_fraction`.
The per-model price/context catalog behind `golem bench cost`'s money figures and
`golem stats --context`'s window check. `catalog_url` is **only** read by
`golem models refresh` — no report path fetches, and Golem's own built-in price table
beats the fetched one on every collision, so a third-party figure can fill a gap but
never overwrite a verified price. `catalog_max_age_days` labels stale data rather than
suppressing it; `context_warn_fraction` only fires when the catalog knows the window.

## Related

[[Guidance Rules]] · [[Compression Levels]] · [[Architecture]] · [[Dogfooding Golem]]
