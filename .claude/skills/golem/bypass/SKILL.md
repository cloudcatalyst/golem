---
description: Send the next request(s) untouched — bypass Golem compression
invocationMode: user
---

<!-- golem:layering-exception slider — same reason as the `slider` skill: a true full
     bypass is level 0, which no tool call may set. The CLI command is named FOR the user. -->

The user wants to bypass Golem's compression pipeline.

Golem's proxy honors the `x-golem-bypass` header for pure passthrough, and
slider level 0 (passthrough) disables all transformation. Note: level 0 ALSO
disables redaction (secrets/PII reach the upstream raw), so prefer `level 1`
(redaction on, byte-faithful) unless a true full bypass is intended.

- For level 1 (the usual answer), call the `level` MCP tool with `1`.
- For a **true full bypass**, do NOT call the `level` tool — it rejects 0 by
  design, so that no tool call can turn redaction off. Tell the user redaction
  would be off and that they must run `golem slider 0` in their own terminal.

Then remind them to run `/golem/slider 1` (or their previous level) to
re-enable savings when done.
