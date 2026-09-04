---
description: Run the full green-check gate before committing — lint, typecheck, tests, and wiki lint — judged by EXIT CODE, not tailed output
invocationMode: user
---

The user wants to confirm the working tree is green before committing (the
batch close-out bar in CLAUDE.md).

Run these via Bash from the repo root, and judge each by its **exit code**, not
by the tail of its output — a run can print errors and still be misread as
passing if you only skim the tail (that mistake has broken CI in this repo
before):

1. `npm run check` — Biome lint + `tsc --noEmit` (strict) + vitest. If a
   step is split out, run `npm run lint`, `npx tsc --noEmit`, and
   `npx vitest run` separately and check each exit code.
2. `golem wiki check` — wiki frontmatter/date/link lint (only if any
   `docs/wiki/` page changed).

Report a short PASS/FAIL table with each step's exit code. On any non-zero exit,
show the failing output and stop — do not suggest committing. Fix the cause (use
the `coder` MCP tool for non-trivial fixes) and re-run. The tree is green only
when every step exits 0.
