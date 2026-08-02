<!-- Managed by Golem — remove with `golem guidance disable ccr-refs` -->

## Golem: oversized tool outputs → CCR

PostToolUse hook replaces oversized tool output with head/tail excerpts +
`hash=<64-hex>` ref. Full original stored under `.golem/ccr`.

Expand via `expand` MCP tool, `/golem/expand <id>`, or `/mcp__golem__expand <id>`.
Only when needed — the full original costs back the tokens saved. Prefer a
narrower re-read or grep first.
