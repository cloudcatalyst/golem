---
title: Golem snooze — park a live session until the limit resets
type: debrief
tags: [snooze, usage-limit, mcp, proxy, autonomy, document-and-hold, decision-38]
sources: [docs/golem-spec.md, docs/plan/proposals/golem-snooze.md, docs/plan/BACKLOG.md]
created: 2026-07-22
updated: 2026-07-22
---

# Golem snooze — park a live session until the limit resets

Shipped **spec Decision 38** across PRs #10–#16: the in-place successor to the
auto-resume feature Decision 37 killed. Auto-resume couldn't deliver "put me
back to work in my open session" because a proxy has no reverse channel into
Claude Code's interactive TUI. Snooze needs none — it keeps the live session
alive *inside a blocking MCP tool call* until the limit resets, then the same
session continues in the same window with context intact. Suite ended **1094
green**; `tsc`/`biome`/`format` clean throughout.

## Why it works (verified 2026-07-18)

Two facts, checked against code.claude.com/docs (see `verification-notes`):

1. **A blocking tool call is a near-free wait** — while an MCP tool blocks the
   model generates nothing, so no quota is spent. Only the small assistant turn
   that *emits* the call costs tokens; that's why prediction matters (fire while
   a little quota remains).
2. **Claude Code bounds tool calls by an *idle* timeout, not total duration** —
   `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (30 min stdio default), reset by progress
   notifications. A tool that emits a progress notification every ~60 s can block
   for hours. Empirically held past the ~2 min auto-background threshold with
   working heartbeats.

## What landed

- **P1 — the `snooze` MCP tool** (`src/mcp/snooze.ts`, #10): input `until` (ISO
  reset) or `duration_ms`; ~60 s heartbeat via `extra.sendNotification` keyed to
  the progress token; honors `extra.signal` (abort); declines waits over a 6 h
  cap. DI-seamed (`Date.now`, `abortableSleep`, notifier) for testing.
- **P2a — limit-prediction observability** (`src/proxy/limit-prediction.ts`,
  #13): an observe-only `onResponseHeaders` proxy hook (header-only, before the
  body pipe) parses the `anthropic-ratelimit-unified-5h-*` / `-7d-*` headers
  (epoch-second reset → ISO), throttled 3 s, to `.golem/state/limit.json`
  (atomic write, zod-validated). No new frozen interface; `ProxyServerOptions`
  gains the hook.
- **P2b — the document-and-hold trigger** (`src/hooks/snooze-nudge.ts` +
  `src/hooks/pre-tool-use.ts`, #15): a PreToolUse nudge (default threshold 0.9
  utilization, one-shot per reset window via `.golem/state/snooze-nudge.json`)
  that, when near the limit, **denies** the next non-snooze tool with an
  instruction to *document where you're up to* (`golem task add`), *then snooze,
  then STOP*. The `snooze` tool itself is exempt (never park the parking call).
  The nudge logic was drafted with the local `coder` model, then hardened
  (see [[Dogfooding Golem]]).
- **Activation — on by default** (`src/cli/init.ts`, #16): `init` wires the
  `golem hook pre-tool-use` PreToolUse hook and seeds the `snooze-hold` guidance
  rule (a [[Guidance Rules]] feature, `seededByDefault: true`). Both are read at
  session start → **a Claude Code restart activates them.**

## The document-and-hold pivot (USER decision, mid-build)

An earlier increment (#12) set a global `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`
override in `init` so the blocking snooze call wouldn't auto-background. The user
judged that too invasive; it was **reverted (#14)**. The design instead *embraces*
auto-background: the parked tool completing at reset re-invokes the agent in-place
via the normal task-completion notification (the same mechanism a CI-watch task
uses), and the durable task written first is the safety net if the window ends
before the reset. This is why the trigger is "document-and-hold", not "block".

## Fixes worth remembering

- **Permissions:** the seven MCP tools + `snooze` auto-allow via the
  `mcp__golem__*` init rule (#11). A **bare `mcp__golem` rule did NOT
  auto-approve** in practice — the anchored wildcard is required.
- **Local-answer hijack (#8):** WebFetch summarization calls were being
  intercepted by local-answer and returned Golem's own KB content (and cached AS
  the page). Band-aided with a `MAX_LOCAL_ANSWER_QUERY_CHARS=1000` gate; the
  durable fix is the backlogged WebFetch raw-cache item.
- **`exactOptionalPropertyTypes`:** optional fields that mirror zod `.optional()`
  need an explicit `| undefined` in the TS type to satisfy the compiler.
- **CI hygiene:** #15 merged with unformatted imports its CI had flagged (I'd
  only `tail`-ed lint output and missed it). #16 cleaned it up; lesson — trust
  `biome check` exit codes, not a scrolled tail.

## Remaining (unautomatable)

Confirm quota actually **restores for the next turn after a real reset
mid-session** — the one claim only a live limit-reset can prove.
