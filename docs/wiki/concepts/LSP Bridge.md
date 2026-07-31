---
title: LSP Bridge
type: concept
tags: [lsp, ext, mcp, tools, tier-2, context-economy]
sources: ["src/ext/lsp/", "src/mcp/server.ts", "src/ext/manifest.ts", "docs/plan/verification-notes.md (§109)", "docs/plan/tasks/R8.6.md"]
created: 2026-07-31
updated: 2026-07-31
---

# LSP Bridge

Golem can ask a **language server the user already installed** four questions about a
position in a file, and surfaces them as **modes of the `code` MCP tool** — not as
tools of their own. Shipped in R8.6, **off by default**.

| mode | question | needs |
|---|---|---|
| `diagnostics` | what is wrong in this file? | `file` |
| `definition` | where is this defined? | `file` + `symbol` or `line` |
| `references` | what refers to this? | `file` + `symbol` or `line` |
| `hover` | what is this, resolved? | `file` + `symbol` or `line` |

`symbol` exists so a caller holding a [[Repo Map]] row (file, line, symbol name) can
ask without counting columns; `line`/`character` are **1-based** on the way in and out,
whatever LSP's 0-based wire says.

## Why modes and not four tools

Every tool definition is a permanent per-request bill (§100). Measured on this repo's
census: the four modes add **+333 full-definition tokens** to the one `code` tool,
while four separate tools would each pay the ~250–320-token envelope a tool costs
before any content — `devices`, whose schema is 9 tokens, still costs ~318 full.

And when it is off, it costs **nothing**: the mode enum, the position parameters and
the extra prose only enter the schema when the bridge is injected. Measure both states
with `golem bench tools` and `golem bench tools --lsp`.

## Posture: tier 2, absence is a no-op

Per [[Managed Tools]] (Decision 53), Golem ships no language server's bytes. It spawns
what is on `PATH` — `PATHEXT`-aware, argument-array, never a shell string — and every
failure resolves to `available: false` plus a reason rather than an error: binary
absent, extension unclaimed, handshake timeout, request timeout, mid-session crash,
protocol desync, unreadable file, missing position.

**Enabled does not mean running.** The server is spawned lazily on the first LSP-mode
call, pooled per server id, and evicted after an idle period. Every wait is bounded —
handshake, request, and the graceful `shutdown`/`exit` before the kill — because a hung
language server in an agent tool call burns the turn, where in an editor it would only
show a spinner. A parent that exits kills its pooled children synchronously so none is
orphaned.

## Turning it on

```
golem config set knowledge.lsp_enabled true
npm i -g typescript-language-server typescript
# reconnect the golem MCP server in Claude Code afterwards
```

Settings ([[Configuration Surfaces]]):

- `knowledge.lsp_enabled` — off by default; also requires `knowledge.repo_map_enabled`,
  since these are modes of that tool.
- `knowledge.lsp_timeout_ms` — per-request budget (default 15,000).
- `knowledge.lsp_servers` — extra rows (`id`, `command`, `args`, `language_id`,
  `extensions`) layered over the built-in `typescript-language-server` one; a matching
  `id` replaces it.

Only the TypeScript row is built in — the one this repo can actually exercise. `gopls`,
`rust-analyzer` and `pyright` are config, not a Golem release: a row Golem asserted but
could not verify is the unverified claim the registry exists to prevent.

## What is not known yet

Whether an agent given `definition`/`references` actually **stops** grepping and
reading whole files. That displacement claim justifies both this and [[Repo Map]], and
neither has evidence — it needs live traffic, not a harness.

## Related

[[Repo Map]] · [[Managed Tools]] · [[Tool Search]] · [[Configuration Surfaces]] ·
[[Context Ledger]] · [[Architecture]]
