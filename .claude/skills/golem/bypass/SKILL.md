---
description: Send the next request(s) untouched — bypass Golem compression
invocationMode: user
---

<!-- golem:layering-exception config — a true full bypass turns REDACTION off, so
     by design no tool call can reach it (R11.1/ADR-0004 moved it to a CLI-only
     setting). Naming the command for the user to run in their OWN terminal is the
     point, not a shortcut around a tool. -->

The user wants to bypass Golem's compression pipeline.

Three different things, in increasing order of what they switch off:

1. **One request** — Golem's proxy honours the `x-golem-bypass` header for a
   pure passthrough of that request. Nothing is configured; nothing persists.
2. **Compression off, redaction still on** — `golem compression off`. This is
   the usual answer: byte-faithful forwarding with secrets still redacted.
3. **A true full bypass, redaction included** —
   `golem config set proxy.bypass_all true`. Tell the user plainly that secrets
   and PII then reach the upstream unredacted, and that they must run it in their
   own terminal: no tool call can turn redaction off.

Then remind them to run `golem compression 1` (or their previous value) to
re-enable savings when done, and `golem config set proxy.bypass_all false` if
they used option 3.
