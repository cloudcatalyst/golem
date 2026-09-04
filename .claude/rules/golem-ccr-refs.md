<!-- Managed by Golem — remove with `golem guidance disable ccr-refs` -->

## Golem: oversized tool outputs → CCR refs

A PostToolUse hook replaces oversized tool output (Bash, Read, Grep, Glob,
WebFetch) with head/tail excerpts + `hash=<64-hex>`. The full original is stored
under `.golem/ccr` — nothing is lost.

Expand via the `expand` MCP tool (`ref_id` = the hex id), `/golem-expand <id>`,
or `/mcp__golem__expand <id>`. Only when the excerpt is genuinely not enough —
the original re-enters context and costs back the tokens the swap saved. Prefer
a narrower re-read or grep first.
