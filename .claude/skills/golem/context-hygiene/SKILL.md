---
description: Keep the working context clean — prefer narrow re-runs and CCR references over re-reading, and expand only what's actually needed
invocationMode: user
---

The user wants to reduce context bloat from accumulated tool output (logs, large
file reads, dead-end retries) — the "keep context clean" technique, which both
cuts tokens and tends to improve results.

Golem already does most of this automatically: a PostToolUse hook swaps oversized
Bash/Read/Grep/Glob/WebFetch outputs for a compact digest carrying a
`hash=<id>` marker, storing the original losslessly under `.golem/ccr` (the
CCR-refs rule). Your job is to use that discipline deliberately:

1. **Prefer narrow over expand.** When you only need part of a swapped output,
   re-run a tighter command (grep the file, limit the line range) instead of
   expanding the whole thing back into context.
2. **Expand only on demand.** When you genuinely need the full original, call the
   `expand` MCP tool with the `ref_id` from the marker (or `/golem/expand <id>`)
   — and only then. Each expand re-spends the tokens the swap saved.
3. **Don't re-read.** If a file/page is already in context or in the KB, use
   `search`/`fetch` for the relevant chunk rather than re-reading the whole
   thing.

This is a working habit, not a one-off command — Golem retains the originals, so
nothing is lost when you keep the live context lean.
