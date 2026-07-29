---
description: Switch the upstream account/provider the correct way — golem account use (auto-restarts the proxy) + reconnect MCP, NOT the Claude Code model picker
invocationMode: user
---

The user wants to change which upstream account/provider Golem forwards to
(e.g. a different Anthropic account, or a Foundry/OpenRouter gateway).
Target: $ARGUMENTS

This is **not** the Claude Code model picker — that chooses a model within the
current account; Golem routes the whole request to a configured upstream. Do it
through Golem:

1. **List accounts.** Run `golem account list` via Bash — shows configured
   accounts, which is active, and whether each has a stored credential.
2. **Switch.** Run `golem account use <id>` (or `golem account use none` to
   revert to the top-level default). This **restarts the proxy automatically**
   so the switch takes effect — no separate `golem proxy restart` needed.
3. **Reconnect MCP.** Tell the user any live `golem mcp serve` connection must
   be reconnected by Claude Code for the change to reflect in the MCP tools.
4. **Confirm.** Report the now-active account and its upstream URL. If a provider
   has no stored credential, say so and give the fix (`golem account login <id>`)
   rather than leaving auth silently broken — there is no environment variable to
   export (spec Decision 47).
