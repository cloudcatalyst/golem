<!-- Managed by Golem — remove with `golem guidance disable ccr-refs` -->

## Golem: oversized tool outputs → CCR refs

A PostToolUse hook replaces oversized tool output (Bash, Read, Grep, Glob,
WebFetch) with head/tail excerpts + `hash=<64-hex>`. The full original is stored
under `.golem/ccr` — nothing is lost.

Expand via the `expand` MCP tool (`ref_id` = the hex id), `/golem-expand <id>`,
or `/mcp__golem__expand <id>`. Only when the excerpt is genuinely not enough —
the original re-enters context and costs back the tokens the swap saved. Prefer
a narrower re-read or grep first.

This rule is generated from Golem's own guidance registry (`src/hooks/guidance.ts`) and distributed by `golem init` / `golem guidance enable` — every Golem-managed project can receive this identical text. This repository, golem.run's own source, runs under the same unedited rule; Golem does not keep a separate house style for itself.
