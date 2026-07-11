---
description: Send the next request(s) untouched — bypass Golem compression
invocationMode: user
---

The user wants to bypass Golem's compression pipeline.

Golem's proxy honors the `x-golem-bypass` header for pure passthrough, and
slider level 0 (passthrough) disables all transformation. Note: level 0 ALSO
disables redaction (secrets/PII reach the upstream raw), so prefer `level 1`
(redaction on, byte-faithful) unless a true full bypass is intended. If setting
level 0, warn the user redaction is off. Call the `level` MCP tool with the
chosen level, then remind them to run `/golem/slider 1` (or their previous
level) to re-enable savings when done.
