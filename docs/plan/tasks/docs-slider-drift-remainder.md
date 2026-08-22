---
task: docs-slider-drift-remainder
title: Widen the retired-identifier check to the spec body, the VS Code README and the last stale strings
state: done
owner: agent
size: M
design: No design needed — the check exists (docs-slider-drift). This is the work of cleaning the surfaces it deliberately did not scan yet, then adding each to `PROSE_FILES_OUTSIDE_WIKI` so it stays clean.
gate: `golem wiki check` scans the spec body and the VS Code README with no issues, and no user-visible string names a control ADR-0004 retired.
depends_on: [docs-slider-drift]
touches: [docs/golem-spec.md, vscode-extension/README.md, src/config/ui-model.ts, src/tui/header.ts, src/cli/wiki.ts]
created: 2026-08-21
updated: 2026-08-21T23:59:05.589Z
---

## Why this exists

`docs-slider-drift` shipped the rule that fails on a retired identifier in
user-facing prose, and cleaned everything inside its scan: `README.md` and every
non-record wiki page. Three surfaces were left out **on purpose**, each recorded
here rather than left as a silent hole in the scanned set.

## 1. `docs/golem-spec.md` — the body, not the Decisions Log

~66 mentions. The Decisions Log (§9) is a dated record and stays exempt, but
§1–§8 still describe the slider as the live control — including the **Status**
line at the top of the file ("slider is a pure 0–3 compression dial (level-0 full
bypass …)") and the whole of §4. That is a spec rewrite against ADR-0004, not a
docs sweep, and it is the source of truth the rest of the repo cites, so it wants
its own pass. Then add `docs/golem-spec.md` to `PROSE_FILES_OUTSIDE_WIKI` — the
scanner will need a Decisions-Log exemption (the record-citation rule already
exempts a unit that names `docs/plan/` or an ADR, which may be enough; verify
against the real file before choosing).

## 2. `vscode-extension/README.md` — 4 lines

Was owned by a live workstream (R12.2/R12.6) while `docs-slider-drift` landed, so
it was not touched:

| line | what it says |
|---|---|
| 6 | "a clickable slider" |
| 17 | "a 0–5 **slider** (click a level)" — note **0–5**, which was never a real range |
| 26 | "(slider level 0 disables redaction) asks first" — contradicts ADR-0004's whole point |
| 29 | "`⬢ Golem · <level> → [local + ]<upstream>` — brand, slider level, and where" |

Line 26 is the one that matters: it teaches that a *number* can turn redaction
off, which is exactly the property ADR-0004 made unrepresentable.

## 3. Stale strings in code that reach a user

Out of scope for `docs-slider-drift` ("no code change beyond the check itself"),
found while doing it:

- `src/config/ui-model.ts:357` — the brevity dial's `summary` still reads
  `"auto (follow the slider) · off · lite · full · ultra"`. `auto` is not a value
  any more (ADR-0004 removed the preset state), so the panel offers a word the
  dial does not accept.
- `src/tui/header.ts:42` — the header segment is still named `slider` (a local
  const). Renders correctly (`Level 1 lossless`), but the name is the last live
  reference in a rendering path.
- `src/dashboard/server.ts:246-247` — `slider-level` / `slider-name` DOM ids.
  Owned by R12.6 at the time; check with that workstream before touching.

## Note for whoever picks this up

The check is in `src/cli/wiki.ts` (`RETIRED_IDENTIFIERS`, `findRetiredIdentifiers`,
`splitProseUnits`). Widening the scanned set is a one-line change to
`PROSE_FILES_OUTSIDE_WIKI`; the reason it is a list rather than a tree walk is so
that adding a surface is a deliberate act with a green suite behind it. Do not
weaken the rule to make a file pass — clean the file.

## Outcome

shipped
