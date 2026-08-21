---
description: Show or set the Golem compression dial (off | 1 lossless | 2 balanced | 3 aggressive)
invocationMode: user
---

The user wants to view or change how much of Golem's pipeline runs.

Arguments: $ARGUMENTS

R11.1 retired the savings slider (ADR-0004): compression and brevity are set
directly, and there is no `level` MCP tool any more — no tool call can change
how much of the pipeline runs.

- If the arguments contain a value (`off`, `1`, `2`, `3`), tell the user to
  run `golem compression <value>` in their terminal, and say what it does. It
  takes effect within a second; no proxy restart is needed.
- `off` means compression off — **redaction still runs**. Say so, because the
  word invites the opposite reading.
- If the user is asking to disable redaction entirely, that is
  `golem config set proxy.bypass_all true`, NOT a compression value. Warn that
  secrets and PII then reach the upstream unredacted, and let them decide.
- If no value was given, call `stats` and report the current compression level.
- If the Golem MCP tools are unavailable, tell the user the Golem MCP server is
  not connected and suggest running `golem init` and restarting Claude Code.
