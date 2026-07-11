---
description: Show or set the Golem token-savings slider (0 passthrough … 3 aggressive)
invocationMode: user
---

The user wants to view or change Golem's savings slider.

Arguments: $ARGUMENTS

- If the arguments contain a level (0-3), call the `level` MCP tool
  with that level, then confirm the change and briefly say what the new level does.
  If the level is 0, warn that redaction is OFF at level 0 (full bypass).
- If no level was given, call `stats` and report the current slider level.
- If the Golem MCP tools are unavailable, tell the user the Golem MCP server is
  not connected and suggest running `golem init` and restarting Claude Code.
