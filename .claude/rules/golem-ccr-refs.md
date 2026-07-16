<!-- Managed by Golem — remove with `golem guidance disable ccr-refs` -->

## Golem: oversized tool outputs are swapped for CCR refs

A PostToolUse hook replaces oversized tool outputs (Bash, Read, Grep, Glob,
WebFetch) with a compact digest: head/tail excerpts, byte/line counts, and a
lossless reference marker like `Retrieve original: hash=<64-hex-id>`. The full
original is stored locally under `.golem/ccr` — nothing is lost.

When the excerpt is not enough, expand the reference:

- call the `expand` MCP tool with `ref_id` set to the hex id, or
- use `/golem/expand <id>` (or `/mcp__golem__expand <id>`).

Expand only when needed — the full original re-enters context and costs the
tokens the swap saved. Prefer re-running a narrower command (grep the file,
limit the range) when you only need a small part.
