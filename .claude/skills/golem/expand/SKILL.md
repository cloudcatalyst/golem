---
description: Expand a Golem CCR reference back to its original content
invocationMode: user
---

The user wants to expand a compressed content reference (CCR).

Arguments: $ARGUMENTS

Extract the CCR reference id from the arguments (or from the marker in recent
context, e.g. `hash=<sha256>` / `[golem:ccr ref=...]`) and call the
`expand` MCP tool with it. Show the retrieved original content. If the
reference is unknown, report that and suggest `golem stats` to check the store.
