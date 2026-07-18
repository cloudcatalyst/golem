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

### Required config (increment 1b — SHIPPED)
`golem init` sets:
- **`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`** in `.claude/settings.json` env —
  **critical, and verified against the docs** (code.claude.com/docs/en/mcp,
  2026-07-18): a main-conversation MCP call still running after ~2 min *"moves
  to a background task … Claude receives the task ID immediately and keeps
  working"* — i.e. auto-background **defeats the pause** (Claude continues and
  burns quota). There is **no per-server override**, so it is set globally.
  Trade-off: other long MCP tool calls also foreground-block rather than
  backgrounding — low impact, since nearly all tool calls finish under 2 min.
  A no-op on Claude Code versions without the feature (so no version gate needed).
- **`timeout: 23_400_000` (6.5 h)** on the golem server entry in `.mcp.json` —
  a per-server wall-clock / idle-timeout floor above snooze's own 6 h cap, so a
  full park completes even if the heartbeat's progress token isn't honored; it
  also backstops a genuinely-stuck golem tool. Fast tools finish well under it.
- The 60 s progress **heartbeat** (P1a) keeps the call under the stdio idle
  timeout (30 min default) during the wait; the `.mcp.json timeout` is the
  belt-and-suspenders fallback if no progress token is sent.

### Sourcing the reset time (increment 2a — SHIPPED)
The proxy sees `anthropic-ratelimit-unified-*` on every response. An observe-only
`onResponseHeaders` hook parses the session (5h) + weekly (7d) window
utilization and reset (`src/proxy/limit-prediction.ts`) and persists the latest
to `.golem/state/limit-state.json` (throttled to ≤ once/3 s). `snooze` can
default its `until` from it, and the P2b trigger reads it to decide "near the
limit". This is the join with the **limit-prediction observability** backlog
item. NOTE: prediction/observability only — NOT the auto-resume detect+capture
Decision 37 removed (reads every response, records state, never captures/spawns).

### The trigger (increment 2 — DECIDED: PreToolUse one-shot)
Golem cannot push "call snooze now" into Claude's decision loop: the proxy is
byte-faithful on responses (no injection seam). So the trigger is a **PreToolUse
hook** — Golem already runs one (the R5.4 autonomy gate), and PreToolUse fires
before *every* tool call (built-in and MCP), which makes it the most reliable
place to catch an approaching limit. Chosen 2026-07-18 (USER decision) over the
Stop-hook (fires only at turn boundaries — can be late in a long turn), the
guidance-rule self-trigger (relies on Claude choosing to poll), and manual-only.

**Critical: one-shot, so it doesn't pollute the conversation.** Firing often is
*not* the same as injecting often — the hook is silent (reads a small state
file, emits nothing) except when it decides to nudge. A **one-shot flag** keyed
to the current reset window (`nudged for reset-at-X`) means it injects a
**single** redirect — deny the pending tool with reason "you're near the usage
limit; call `mcp__golem__snooze` to wait it out" — regardless of how many times
it fires. So the per-tool-call frequency drives *catching the limit in time*,
not transcript noise.

Design notes:
- **Exempt `mcp__golem__snooze` itself** from the gate (else the nudge denies the
  very call it asked for — a loop).
- **Piggyback the existing gate** when autonomy is wired (near-zero added cost);
  when it isn't, this introduces a PreToolUse hook (per-tool-call check, still
  silent unless nudging).
- **Threshold with margin** (e.g. ~90 % window utilization, not 99 %) so the
  nudge — and the snooze call it triggers — still has quota to be emitted.
- The one-shot flag resets when the reset window rolls over, so the next window
  gets exactly one nudge again.

Manual invocation stays available at every level (you, or a prompt you leave,
call `snooze`) — the automatic PreToolUse path is additive.

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
