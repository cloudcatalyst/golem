# Proposal: Golem snooze — park a live session until the usage limit resets

> **Status: PROPOSED (2026-07-18), spike-first.** The in-place successor to the
> abandoned auto-resume (Decision 37). Auto-resume couldn't deliver "resume in my
> open session" because a proxy can't drive Claude Code's interactive TUI; the
> community tmux tools do it by keystroke-injecting a live pane. **Snooze needs
> neither** — it keeps the live session alive *inside a blocking tool call* until
> the limit resets, then the same session continues in-place. Pairs with the
> backlogged limit-prediction observability item (predict → snooze).

## Problem
A session/usage limit stops work mid-task and loses momentum. Everything we've
evaluated either revives a *dead* session as a separate `bg` process (headless
`--resume`, Decision 37 / spawn) or puppets the live TUI with fragile
tmux/keystroke injection (`claude-auto-retry` et al.). Neither continues the
conversation *in the window you have open*.

## Why this works where auto-resume couldn't (verified)
Two facts, checked against the live Claude Code docs (2026-07-18):

1. **A tool call is a near-free wait.** While an MCP tool blocks, the model
   generates nothing, so no quota is consumed. The only tokens spent are the
   small assistant turn that *emits* the tool call — which is why prediction
   matters: fire the snooze while a little quota remains.
2. **Claude Code has no hard max tool-call duration.** Long calls are bounded by
   an *idle* timeout (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, default 30 min for
   stdio servers — `golem mcp serve` is stdio), and *"a tool can run indefinitely
   as long as it sends progress notifications"* (the idle window measures
   idleness, not total duration; settable to 0 to disable). Source:
   code.claude.com/docs/en/mcp, /en/env-vars, /en/errors.

So a `snooze` tool that emits a progress notification every ~60 s can block the
**live** session for hours, then return — context intact, same window, Claude
continues. This is the only mechanism we've found that resumes in-place.

## Design

### `snooze` MCP tool (increment 1 — core, trigger-independent)
- New tool on `golem mcp serve`. Input: `until` (ISO reset time) **or**
  `duration_ms`, plus a hard `max_ms` cap (safety). Blocks until the target,
  emitting an MCP **progress notification** every ~60 s to reset the idle timer.
  Returns `{ reset: true, waited_ms }` on completion.
- **Cancellable** (honors the request abort signal) so the user can bail out.
- **Fail-safe:** if it cannot emit progress (SDK/transport can't), it returns
  promptly with `{ reset: false, reason }` rather than hanging the session —
  degrade to "no snooze," never to a stuck window.

### Required config (increment 1)
`golem init` sets, for the `golem` MCP server:
- `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` raised (or `0`) so the heartbeat governs.
- `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` — **critical.** The default (~2 min)
  auto-backgrounds long tool calls *so the session stays usable*, which is the
  opposite of parking: a backgrounded snooze would let Claude keep working and
  keep burning quota. Snooze must **foreground-block**.
- Requires **Claude Code v2.1.203+** (per-server timeout floor + stdio idle
  timeout). `golem` should detect and warn on older versions.

### Sourcing the reset time
The proxy already sees `anthropic-ratelimit-unified-*-reset` on every response.
Persist the latest predicted reset to `.golem/state/` so `snooze` can default
its `until` from it (or the caller passes it). This is the join with the
**limit-prediction observability** backlog item.

### The trigger (increment 2 — THE open decision)
Golem cannot push "call snooze now" into Claude's decision loop: the proxy is
byte-faithful on responses (no injection seam). Candidate triggers, each with a
different reliability/timing profile:

- **(a) Guidance rule — Claude self-triggers.** A `.claude/rules/golem-*.md`
  tells Claude to check Golem's limit status and call `snooze` when near. Simple,
  reuses the existing guidance mechanism — but relies on Claude *choosing* to
  poll/remember, and each check costs a few tokens.
- **(b) Stop-hook nudge.** A Stop hook checks the limit at turn boundaries and,
  when near, blocks the stop with "call `snooze`" (nonstop's pattern).
  Deterministic *at stops* — but may fire late inside one long turn.
- **(c) PreToolUse-gate piggyback.** Golem already runs a PreToolUse hook (the
  R5.4 autonomy gate). Extend it: before a tool call, if near-limit, `ask`/deny
  with reason "snooze first." Fires very frequently (every tool call), so it
  catches the approach reliably, and reuses machinery that already exists.
- **(d) Surface-only + manual.** Golem predicts and surfaces "near limit"
  (status line / notification); you (or a prompt you set before leaving) call
  `snooze`. Simplest, most predictable, zero magic — but not hands-off.

**Recommendation:** (c) for the automatic path (most reliable, reuses the gate),
with (d) always available as the manual path. But this is the fork to confirm
before building increment 2.

## Spike unknowns (verify before over-investing)
1. **Does a heartbeating stdio tool actually hold** past the 30-min idle default
   and past auto-background, as a foreground block? → increment 1; test with a
   short wait (prove it survives past the ~2-min auto-background threshold) then
   a longer one.
2. **Does quota restore for the next turn after the window resets, mid-session?**
   The whole premise. → manual, needs a real limit; cheap to confirm once.
3. **Which trigger is least fragile in practice?** → increment 2.

## Risks
- **Machine must stay awake / session alive** for the whole wait (same constraint
  as every wait approach; OS sleep-prevention, like Claude-Autopilot's, is a
  later add, not P1).
- **Config + version coupling** to Claude Code's MCP timeout knobs (v2.1.203+).
- **Trigger reliability** — the open decision above.
- **Too-late prediction:** if the limit is already hit, the turn that would emit
  the snooze call is itself blocked. Mitigated by triggering with margin (e.g.
  ~90 % utilization, not 99 %).
- No frozen-interface change expected: `snooze` is a new MCP tool; the proxy
  gains a small "persist observed reset" side-write. Redaction/fidelity
  untouched (snooze never transforms request/response content).

## Phasing
- **P1 — the tool + config + manual trigger.** Ship `snooze`, wire the MCP config
  in `init`, and let the user/Claude call it explicitly. Verify unknowns 1–2.
- **P2 — automatic trigger + prediction wiring.** Build the chosen trigger and
  persist the observed reset for `snooze` to default from. Verify unknown 3.
