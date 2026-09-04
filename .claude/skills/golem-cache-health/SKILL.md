---
description: Report prompt-cache health — hit rate and likely cache-busting — so you can see savings you're silently losing
invocationMode: user
---

The user wants to know how well Anthropic prompt-caching is working. Caching is
where the real savings are on Anthropic traffic (compression is ~0% there,
Decision 23), and one changed byte in the cached prefix — an injected timestamp,
a reordered tool-definition block — silently turns a cache read into a full
re-bill.

1. **Read the current signal.** Call the `stats` MCP tool and run
   `golem status` via Bash, and surface whatever cache fields are present:
   cached-read vs cache-creation vs uncached input tokens, and a hit rate if
   available.
2. **Flag cache-busting.** If the hit rate is low or dropping, call it out and
   name the usual culprits to check: a timestamp/nonce in the system prompt or a
   tool arg, a reordered or newly-added tool/MCP-definition block (these sit in
   the cached prefix), or a mid-history rewrite.
3. **Be honest about coverage.** Full per-request cache-bust detection is a proxy
   feature still on the backlog (2026-07-24, "cache-hit observability") — if the
   telemetry doesn't yet expose a field, say so plainly. Never present a guess as
   a measured number.
