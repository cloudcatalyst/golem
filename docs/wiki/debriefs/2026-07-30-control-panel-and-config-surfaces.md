---
title: golem ui — one control surface behind three UIs
type: debrief
tags: [config, tui, ink, vscode, control-surface, ui, settings]
sources: [src/config/ui-model.ts, src/config/control-surface.ts, src/tui/, src/cli/main.ts, vscode-extension/render.js, docs/golem-spec.md]
created: 2026-07-30
updated: 2026-07-30
---

# 2026-07-30 — the config was fine; nobody could see it

Asked for a Claude-Code-style terminal panel: an info header, a purple
block-character pet on the left, and a way to toggle settings — plus terminal,
CLI, and VS Code ways to manage preferences at user and project level. The ask
came with an expectation that "this will likely cause the config to need to be
refactored".

Shipped under [spec Decision 50] (USER decision on the ink question). The concept
page is [[Configuration Surfaces]]; related: [[Guidance Rules]],
[[Slider Levels]], [[Architecture]].

## The config did NOT need refactoring

Worth recording, because the instinct was reasonable and wrong. Precedence,
provenance, atomic scoped writes, and env overrides already worked correctly
(`src/config/loader.ts`, `write-setting.ts`, `env.ts`) and were well covered by
tests. Not one line of the loader changed.

What was actually missing was **presentation**. `schema.ts` describes 37 settings
leaves as zod validators with genuinely good doc comments — and doc comments are
invisible at runtime. So any UI had to re-type every label, which is precisely why
the VS Code panel had, for months, exposed only the slider and the account. The
fix was to add a layer, not to rework one.

The second half of the problem was fragmentation: three unrelated stores, three
unrelated verbs, no shared vocabulary.

| Family | Store | Scopes | Verb |
|---|---|---|---|
| Settings | `.golem/settings.json` + `GOLEM_*` | user · project · local · env | `golem config` |
| Guidance | `.claude/rules/golem-<name>.md` (presence = toggle) | project · user | `golem guidance` |
| Runtime | slider · active account · proxy daemon | each its own | `slider` / `account use` / `proxy` |

## Compile-enforced metadata, derived widgets

`SETTING_META` in the new `src/config/ui-model.ts` sits beside `SETTINGS_LEAVES`
rather than replacing it, and is annotated:

```ts
} as const satisfies { readonly [P in LeafPath]: SettingMeta };
```

`LeafPath` is a mapped-type union derived from the leaf table, so **adding a
settings key without describing it is a compile error**. No sync test, no drift.
(A parallel table was chosen over widening `SETTINGS_LEAVES` into
`{schema, ...meta}` objects specifically to avoid touching the 11 existing
`leafSchema()` / `Object.keys()` call sites in the loader, env mapper, and writer.)

Widget kinds are **derived from zod** (`deriveKind`), not hand-declared, so a type
change can't leave a stale widget behind. `SettingMeta.kind` overrides only where
zod genuinely can't express intent — a hex colour is just a validated string.

`ownedBy` earns its place: `slider.level` and `proxy.active_account` are omitted
from the settings groups because a Runtime control edits the same key with a better
affordance. Without it, the panel would offer two different ways to change one key.

## Two rules that came out of building it

**Env-supplied controls must be locked.** The first draft let you toggle a row
whose effective value came from `GOLEM_*`. The write succeeded, the file changed,
and nothing happened — env beats every file layer. That is a worse experience than
refusing. Such rows now render with the reason and `applyControl` throws rather
than writing.

**A `danger` confirm belongs on the direction, not the control.** Slider level 0 is
the redaction-off full bypass (Decision 30), so *going to* 0 asks for an explicit
`y`; coming back never does. Prompting on the safe direction trains people to
dismiss the prompt.

## The pure-reducer split paid for itself immediately

`src/tui/state.ts` is `(state, event) → {state, effects}` with no ink, no terminal,
no filesystem. `tests/unit/tui-state.test.ts` covers 32 behaviours — cursor
anchoring past group headings, enum wrap vs list clamp, locked-row refusal,
empty-field-means-unset, cancel-on-anything-but-`y` — in 19ms, with no rendering.
`app.tsx` only performs effects. Every interaction bug found during the build was
found there rather than by squinting at a frame.

The one real ink render (`tests/integration/tui-render.test.tsx`) exists only to
prove the components mount and the pet, header, and rows appear.

## ink was the user's call; two guards make it safe

Offered a hand-rolled dependency-free TUI (the repo already has a raw-mode TTY
prompt in `src/credentials/prompt.ts`) versus ink + React. The user chose ink.
Both are pure JS — no native or GPU components — so CLAUDE.md's heavyweight-deps
ban isn't engaged, but it did take `golem-run` from 6 runtime dependencies to ~34
transitively (38 packages added). That trade is recorded in Decision 50 rather
than left implicit.

Guard one, and the most important thing in this batch: **ink is reachable only
through a dynamic import.** `golem hook pre-tool-use` runs on *every* Claude Code
tool call, and the proxy and MCP daemons share `src/cli/main.ts` — a static import
of ink + React + yoga-layout would have put that load on all of them. It is the
kind of regression nothing else would catch, so
`tests/unit/tui-lazy-import.test.ts` asserts no static `src/tui` import exists in
`main.ts`, and that no module outside `src/tui/` statically imports ink or React at
all. `src/tui/index.tsx` defers ink one step further, so a config error reports
itself as plain text instead of from inside a half-mounted alternate screen.

Guard two is the reducer split above.

## Bare `golem` without breaking commander

The obvious implementation — a root `program.action()` — quietly broke error
reporting: with an action handler on the root, commander treats an unknown
subcommand as an excess positional and says *"error: too many arguments. Expected
0 arguments but got 1"* instead of *"error: unknown command 'bogus'"*. Caught by
checking it after the build rather than assuming.

The panel is now chosen **before** `program.parseAsync`, gated on
`argv.length <= 2 && stdin.isTTY && stdout.isTTY`. Verified unchanged afterwards:
`golem --help`, `golem --version`, `golem bogus`, and `golem | cat`.

## Toolchain friction worth remembering

Recorded in full in verification-notes §85; the parts that cost time:

- **`tsx` ignores tsconfig's `jsx` setting** (`ReferenceError: React is not
  defined`), and a `@jsxImportSource` pragma didn't rescue it. `tsc` and vitest
  both honour it. Run ad-hoc panel scripts against `dist/`.
- **`exactOptionalPropertyTypes` vs ink**: `<Text color={undefined}>` is a type
  error. Rather than thread "maybe no colour" through every component, the
  `ui.color: "never"` policy sets `FORCE_COLOR=0` before ink is imported (chalk
  fixes its level at import time), keeping every theme field a real string; a
  `col()` helper spreads in the genuinely-optional ones.
- **Enabling `jsx` made Biome lint the whole repo as React**, so pre-existing
  `useAccount(...)` calls in plain `.ts` tripped `useHookAtTopLevel`. That rule is
  now scoped off for `**/*.ts` and left on for `src/tui/**`. Biome's config is
  strict JSON — a `"//"` comment key is a hard config error, which is why the
  rationale lives here and in [[Configuration Surfaces]] instead.
- **`ink-testing-library@4` does work with ink 7**, despite pinning `ink ^5` in its
  own devDependencies. That was flagged as a risk up front; it turned out to be a
  non-issue.

## Two rendering bugs the frame preview caught

Neither would have failed a test that only checked for substrings:

1. The header rule was `RULE_CHAR.repeat(width - 1)`, which wrapped onto a second
   line because the outer `<Box paddingX={1}>` costs two columns. Now `width - 4`.
2. `proxy.accounts` rendered as `[object Object], [object …` — `formatValue`
   checked `Array.isArray` before considering element type. A structured array now
   reads `3 entries`.

Rendering a real frame and *looking at it* was worth more than the assertions.

## Verified

`tsc --noEmit`, `biome check`, `format:check`, and `vitest run` (141 files, 1530
tests) all green **by exit code**; 43 `node --test` tests in the extension. Then,
against a throwaway project through `applyControl` itself: a project-scope write
producing a one-key file diff; a user-scope write correctly reporting that project
still wins; a guidance rule file appearing with its restart hint; the slider
writing `settings.local.json` regardless of the scope asked for (Decision 43) and
raising the level-0 redaction warning; and an out-of-range `proxy.port` rejected
with the file untouched.

## Follow-up: it was slow, and the profile was surprising

The panel took "a number of seconds" to appear. Full numbers in
verification-notes §86; what's worth carrying forward:

**Measure in fresh processes.** The first profile ran several imports in one
process, which made whichever loaded first pay for all the shared sub-dependencies
— it reported `src/config` at 620ms when the real figure is ~130ms. That reading
would have sent the fix somewhere useless.

**I had caused part of it.** Re-exporting `control-surface.js` from
`src/config/index.ts` took that barrel from ~130ms to ~530ms, and
`src/hooks/pre-tool-use.ts` imports the barrel — so I'd added ~400ms to a path that
runs on *every Claude Code tool call*. The panel was the visible symptom; the hook
regression was the more serious one, and nothing would have caught it. There's a
test for it now.

**The fix was "don't load", not "load in parallel".** Making ink, the components,
and the config load concurrently saved **70ms out of 1800**: module evaluation is
single-threaded CPU work, so it doesn't overlap. What worked was removing things
from the path — `main.ts` became a dependency-free shim that dynamically imports
either the panel or the CLI (~790ms of commander-and-everything skipped on a bare
`golem`), the header became nullable and lazy, and the slider's read half moved to
`cli/slider-read.ts` so *displaying* a level no longer loads the write path's
`init.js`.

**The best UX win was the cheapest change.** An ANSI pre-paint of the pet — three
lines of constants, no imports — puts something on screen at **~80ms**. Panel
interactive went ~2.5–3s → ~1.15s, but the pre-paint is what makes it stop feeling
broken.

`module.enableCompileCache()` measured *worse* (948 → 1022ms warm) and was dropped.

**ink is now ~75% of the remaining startup**, and it's spread across its dependency
tree (`es-toolkit` ~194ms, `cli-truncate` ~78ms, `react-reconciler` ~77ms, `ws`
~72ms, …) rather than concentrated anywhere patchable. Going materially below ~1s
means replacing ink — which is the trade Decision 50 recorded, now with a number
attached.

## Left open

- **`bun build --compile` + yoga-layout's WASM is UNVERIFIED** (no Bun on this
  box). The panel may not work inside the standalone binaries (Decision 41d) —
  the npm path is verified. Test in the release workflow before advertising
  `golem ui` for the no-Node tier. Folds into the existing 🔬 R7.3 smoke-test.
- **U+25A0 in the pet is Ambiguous-width**, so it may draw double-wide in a
  CJK-configured terminal. Mitigated (fixed-width box) rather than solved;
  `ui.pet false` / `--no-pet` is the out, and also covers legacy Windows consoles.
- The panel edits values as text; there's no picker for `knowledge.watch_paths`
  beyond comma-separated entry.
- **`golem hook pre-tool-use` (~765ms, every tool call) and `golem statusline`
  (~835ms, every prompt) still route through commander** and pay its ~725ms. In
  aggregate that costs far more than the panel ever did. The `main.ts` shim makes
  the fix straightforward — give those two their own lightweight entries — but it
  was out of scope here and is measured in verification-notes §86.
