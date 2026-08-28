---
title: Hosted multi-turn claude CLI spike (R13.1)
type: synthesis
tags: [r13, adr-0007, spike, stream-json]
sources: [https://code.claude.com/docs/en/cli-reference]
updated: 2026-08-23
created: 2026-08-23
---

# Hosted multi-turn claude CLI spike (R13.1)

Client `2.1.235`. This page records what R13.1 measured before building on `docs/decisions/ADR-0007-remote-conversation-and-hosted-sessions.md` section 3a.

## What was established

| item | label | result |
|---|---|---|
| Multi-turn input | **[OBSERVED]** | `-p --input-format stream-json --output-format stream-json` accepts second message after first `result` event, same `session_id` kept |
| Structured output | **[OBSERVED]** | Tool calls and tool results arrive as separate event objects correlatable by `tool_use_id` |
| Interruption | **[OBSERVED]** Windows / **[UNESTABLISHED]** POSIX | `child.kill(SIGINT)` does not interrupt a running turn on Windows — process-kill only |
| Resume/identity | **[OBSERVED, partial]** / **[UNESTABLISHED]** reboot | Cross-process resume works; machine-reboot survival not tested |
| Project scope | **[OBSERVED]** | `.claude/settings.json` hooks fire in hosted session via cwd alone |
| Permission behaviour | **[OBSERVED]** | Headless `ask` resolves to synchronous refusal — no dialog possible |
| Proxy interposition | **[OBSERVED]** | Traffic flows wherever `ANTHROPIC_BASE_URL` points |
| Cost/lifetime | **[OBSERVED]** rough | $0.21-$0.51 per trivial turn cold-cache at Opus-5; idle costs nothing beyond OS process |

## Verdict

The `claude` CLI qualifies as the runner for ADR-0007 section 3a. Two documented gaps, neither a viability failure: Windows SIGINT gap (item 3) and park semantics (item 8). See `docs/plan/verification-notes.md` §142.

Full close-out: [[R13.1 -- Spike: hosted multi-turn claude CLI viability]]. Downstream: [[Conversation Store]].
