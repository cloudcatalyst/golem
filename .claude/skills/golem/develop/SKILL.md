---
description: Orchestrate building a feature or fix end-to-end — research the wiki/KB, draft code+tests with the coder tool, verify, iterate
invocationMode: auto
---

The user (or Claude's own judgment) has identified development work to do: $ARGUMENTS

1. **Research first.** Run the `/golem/research` skill (or its steps
   directly: `wiki_read` the likely page, else `search` + `fetch`) for the
   feature area so you understand existing patterns, prior decisions, and
   frozen interfaces before writing anything.
2. **Draft with `coder` first.** Per this project's coder-first convention,
   call the `coder` MCP tool to draft the implementation and its tests,
   passing the research context gathered above.
3. **Review and finalize.** Treat the draft as a starting point, not a final
   answer — rewrite anything that doesn't fit this codebase's conventions
   (frozen interfaces, TS strict, zod at boundaries, no unneeded abstraction).
4. **Verify.** Run the project's check command (e.g. `npm run check` — lint
   + typecheck + test) via Bash. On failure, fix and re-run; use `coder`
   again for non-trivial fixes.
5. **Report** what changed and which files were touched. Don't commit unless
   asked.

If `coder`/`research` are unavailable, say the Golem MCP server isn't
connected and suggest `golem init` and restarting Claude Code.
