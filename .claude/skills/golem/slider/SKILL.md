---
description: Show or set the Golem token-savings slider (0 passthrough … 3 aggressive)
invocationMode: user
---

<!-- golem:layering-exception slider — level 0 turns redaction OFF, so by design no
     tool call can reach it (the `level` tool refuses 0). Naming the CLI command for
     the user to run in their OWN terminal is the point, not a shortcut around the tool. -->

The user wants to view or change Golem's savings slider.

Arguments: $ARGUMENTS

- If the arguments contain a level (1-3), call the `level` MCP tool
  with that level, then confirm the change and briefly say what the new level does.
- If the level is 0, do NOT call the `level` tool — it rejects 0 by design, so
  that no tool call can turn redaction off. Warn that redaction is OFF at level 0
  (full bypass) and tell the user to run `golem slider 0` in their terminal.
- If no level was given, call `stats` and report the current slider level.
- If the Golem MCP tools are unavailable, tell the user the Golem MCP server is
  not connected and suggest running `golem init` and restarting Claude Code.
