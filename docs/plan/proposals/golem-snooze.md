# Proposal: Golem snooze — park a live session until the usage limit resets

> **Status: SHIPPED (2026-07-22), spec Decision 38.** Landed across PRs #10–#16
> (snooze MCP tool, limit-prediction observability, document-and-hold PreToolUse
> trigger, on-by-default activation). Kept as the verified design record; the
> authoritative entry is Decision 38 in `docs/golem-spec.md`. One item remains
> unautomatable: confirm quota actually restores for the next turn after a real
> reset mid-session.
>
> _Original proposal below._
>
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

### Approach: document-and-hold, not foreground-block (revised 2026-07-18)
The first cut (1b) forced a **foreground block** by globally disabling
Claude Code's auto-backgrounding (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`). That
was invasive (global, affects every MCP server) — so it was **reverted** in
favour of *embracing* backgrounding:

- A main-conversation MCP call past ~2 min auto-backgrounds; *"Claude receives
  the task ID … and keeps working, and the result arrives as a task
  notification when the call settles"* (code.claude.com/docs/en/mcp). That
  completion notification **re-invokes the agent in-place** — the same mechanism
  that resumes this repo's own background-task watches.
- So the near-limit flow is **document+snooze → wait** (P2b): the agent calls
  `snooze` with `note="<where it's up to + next steps>"` and **stops** (the
  PreToolUse gate denies further tool work; guidance says wait). The session
  idles — **no quota burned** — and when `snooze` completes at the reset, its task
  notification resumes the agent in-place. The note is filed as an R5.1 durable
  task *before* the wait — the safety net if the session dies before then.
- **Revised 2026-07-31 (task `snooze-taskadd`, §105).** Documenting was originally
  a *separate first step* — `golem task add "<note>"` through `Bash`. Decision 45
  then made enforcement the default, and enforcement denies every non-`snooze`
  call: step 1 was denied by step 2's own mechanism, observed live 2026-07-30. The
  alternative — exempting that `Bash` command — would have re-opened the hole
  enforcement exists to close, on a string match. Folding the note into `snooze`
  makes the ordering problem **structurally impossible** instead of exempted:
  the one permitted tool is the one that writes the safety net. See
  `src/mcp/snooze-note.ts`.
- No global override needed. The only remaining config is per-server, non-invasive:
  **`timeout: 23_400_000` (6.5 h)** on the golem `.mcp.json` entry — a wall-clock
  cap above snooze's own 6 h cap (default `MCP_TOOL_TIMEOUT` is ~28 h, so this is
  a tighter backstop). Applies even while backgrounded. The 60 s progress
  **heartbeat** keeps the call under the idle timeout.

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

## Phasing / status
- **P1a — ✅ the `snooze` MCP tool** (heartbeat, cancel, cap). Empirically verified
  to hold 2.5 min past the auto-background threshold with working heartbeats.
- **P1b — ✅ per-server `.mcp.json` timeout.** (The global auto-background override
  was tried then reverted — see "document-and-hold" above.)
- **P2a — ✅ prediction:** proxy persists the observed session/weekly window
  utilization + reset to `.golem/state/limit-state.json`.
- **P2b — ✅ the trigger core:** `src/hooks/snooze-nudge.ts` + PreToolUse
  integration (one-shot deny → document-and-hold, snooze exempt) + the
  `snooze-hold` guidance rule + `snooze` classified harmless. Decision logic
  drafted with the local `coder` model, then hardened.
- **Remaining — ACTIVATION (open decision):** the nudge only fires where the
  PreToolUse hook is wired (today: `golem autonomy wire`). Whether `golem init`
  should wire it — and seed the `snooze-hold` guidance — **by default** (automatic
  snooze, at the cost of a per-tool-call hook in every project) vs. keep it
  opt-in, is the last call to make.
- **Manual verification (unchanged):** does quota actually restore for the next
  turn after a real reset, mid-session? Needs a real limit hit.
