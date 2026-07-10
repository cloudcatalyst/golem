---
description: Send the next request(s) untouched — bypass Golem compression
invocationMode: user
---

The user wants to bypass Golem's compression pipeline.

Golem's proxy honors the `x-golem-bypass` header for pure passthrough, and
slider level 0 disables all transformation. Call the `level` MCP
tool with level 0 to switch to passthrough now, tell the user compression is
off, and remind them to run `/golem/slider 1` (or their previous level) to
re-enable savings when done.
