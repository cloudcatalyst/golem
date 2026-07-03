# Workstream brief — agent-mcp (WS-B: MCP server & Claude Code integration, P0)

Read `CLAUDE.md` first; it binds. Spec: `docs/edge-offload-spec.md` §2.1, §5.1, Decisions 14, 18; plan §2.5.
Live-doc facts you must honor: `docs/verification-notes.md` §8–§11 (hooks schema,
`claude mcp add`, prompt surfacing, skills format — verified 2026-07-03).
Work on branch `ws-b`; claim tasks by ID in PR titles (e.g. "B1: ...").

## Mission
One unified MCP server (`@modelcontextprotocol/sdk`, v1.29.0 line): EOL's tools,
MCP prompts that surface as `/mcp__eol__<cmd>` slash commands, plus the Claude Code
hook that swaps oversized tool outputs for CCR refs.

## Frozen names (plan §2.5 — do not rename)
Tools: `eol_search`, `eol_get_chunk`, `eol_index_path`, `eol_expand`, `eol_stats`,
`eol_set_slider`, `eol_delegate`, `eol_devices`.
Prompts: `slider`, `index`, `search`, `stats`, `expand`, `bypass`, `devices`,
`delegate` → surface as `/mcp__eol__slider` etc. (verified format, notes §10).

## Task list (in order)
- **B1 — Unified MCP server.** `src/mcp/` on the official TS MCP SDK; stdio +
  streamable HTTP transports; zod schemas on every tool param. P0 tools:
  `eol_expand` (→ `CompressionService.retrieve`), `eol_stats` (→ `.stats()` +
  telemetry), `eol_set_slider` (session-scoped policy override). Define all 8
  prompts. Note (Decision 18): Headroom's own MCP server is Python-only — there is
  nothing to re-export in P0; `eol_expand`/`eol_stats` cover the CCR/stats surface
  natively. Sidecar tool bridging is P2.
- **B2 — Claude Code wiring.**
  - **Hook:** `PostToolUse` hook replacing oversized tool outputs with CCR refs via
    `hookSpecificOutput.updatedToolOutput` (mechanism verified — notes §8, schema
    and stdin payload documented there). Ship it as a CLI subcommand (`eol hook
    post-tool-use`) so it's cross-platform — never a shell script. Threshold via
    `EOL_HOOKS_MAX_TOOL_OUTPUT_TOKENS`.
  - **Guidance writer:** appends the EOL section to the project's CLAUDE.md between
    `<!-- eol:guidance:start/end -->` markers ("prefer eol_search over bulk file
    reads", command list). Coordination with `headroom learn` writers only matters
    when the P2 sidecar is present — design the markers so they can't collide.
- **B3 — P1 tools.** `eol_search`/`eol_get_chunk`/`eol_index_path` (thin wrappers
  over WS-C `KnowledgeBase`), `eol_delegate` (WS-D `InferenceService`),
  `eol_devices` (WS-D capabilities). Ship behind capability checks: tools respond
  with a friendly "not available yet" until the backing service exists.

## Registration facts (WS-E owns `eol init`; you own the server + assets)
- `claude mcp add eol -- eol mcp serve` (stdio) or `claude mcp add --transport http
  eol http://localhost:<port>/mcp`; project scope writes `.mcp.json` (notes §9).
- Short commands are directory-namespaced skills: `.claude/skills/eol/<cmd>/SKILL.md`
  → `/eol/slider` — **colon names are invalid** (notes §11, spec Decision 14).
  You author the SKILL.md contents under `src/mcp/claude-assets/`; WS-E's
  `eol init` installs them.

## Interfaces
- **Provides:** the MCP tool/prompt surface (frozen names above) + the hook CLI.
- **Consumes:** `CompressionService` (WS-A), `KnowledgeBase`/`FederatedSearch`
  (WS-C), `InferenceService` (WS-D), `SliderPolicy`, `src/telemetry/`.

## Files owned
`src/mcp/` (incl. `claude-assets/`), your tests in `tests/contract/` +
`tests/integration/`.

## Dependencies
B1 can start now against the frozen interfaces — use in-memory fakes implementing
`CompressionService` until WS-A's implementation merges (the harnesses in
`tests/contract/*-contract.ts` define expected behavior; registering your fakes
against them is encouraged). B2's hook needs WS-A's CCR store to be real. B3 waits
for WS-C/WS-D implementations.

## P0 definition-of-done slice
1. `/eol/slider`, `/eol/stats`, `/eol/expand`, `/eol/bypass` (skills) and their
   `/mcp__eol__*` prompt twins work in a live Claude Code session (DoD #4).
2. MCP server registers cleanly via `claude mcp add` on all 3 OSes.
3. PostToolUse hook round-trip: oversized output → CCR ref → `eol_expand`
   retrieves the original.
