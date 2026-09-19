---
title: Persona Auto-Sync Watcher, Telemetry Perf Fix, and Zombie-Process Diagnosis
type: debrief
tags: [personas, telemetry, statusline, daemon]
sources: [src/cli/persona-sync.ts, src/cli/persona-watcher.ts, src/cli/version-sync.ts, src/telemetry/jsonl-store.ts, src/cli/fast-path.ts, docs/plan/verification-notes.md]
created: 2026-09-18
updated: 2026-09-18
---

# Persona Auto-Sync Watcher, Telemetry Perf Fix, and Zombie-Process Diagnosis

## What changed

Three distinct improvements landed together:

1. **Persona artifacts regenerate automatically** — `.claude/agents/golem-<id>.md` and the `golem-prefer-persona-agents.md` steering rule are now correct on every Claude Code SessionStart (via `version-sync.ts`, unconditional, decoupled from the version-bump gate) and stay live via a polling watcher in the proxy daemon (`persona-watcher.ts`). Contributors no longer run `golem init` manually to pick up persona config changes.

2. **Telemetry performance recovered** — `TelemetryStore.aggregate()` previously re-parsed the entire `events.jsonl` on every call. Now: incremental rollup cache + rotation (new shape in `jsonl-store.ts`), with retention bounded to the current file plus one prior rotation. Result: `golem statusline` invocations dropped from **~900ms to ~450ms** on this repo's 25MB+ log.

3. **Zombie process diagnosis and fix** — 55 orphaned `golem statusline` processes (2.3GB RSS) accumulated on Windows. Root cause: stdin pipe leak in `runStatusline()` letting processes survive indefinitely. Fixed with proper stream teardown plus a 5-second watchdog (`setTimeout(() => process.exit(0), 5_000).unref()`) in `src/cli/fast-path.ts` as a hard backstop. Clearing the zombie processes immediately dropped system CPU load from ~100% to ~25%.

## Why this matters

**Persona configuration reaches contributors without friction.** The old workflow — change `inference.personas` in project settings, run `golem init`, commit — is now automatic. A settings edit reaches `.claude/agents/` on the next SessionStart within the same session (via daemon watcher), and on the very next session without any action. This unblocks per-project persona rosters as ordinary config without a hidden manual step.

**The telemetry bottleneck is now measurable.** At 25MB of events, the cost of `statusline` is parsing, not I/O or Node startup. The incremental shape (rollup in memory, rotate on threshold, re-parse only the new chunk) means adding events stays O(n) where n is the daily increment, not the archive size. The retention cap (current + 1 prior) is intentional, making it a follow-up question rather than a technical debt — see task 9833dd37-74b1-4e7b-80ff-52b220546c9b.

**Windows resource cleanup avoids cascade failures.** Orphaned processes consume system resources and raise CPU utilization, which then causes test timeouts (load flakes) and makes it hard to distinguish real bugs from environmental saturation. The 5-second watchdog is crude but unambiguous: a process that is not torn down cleanly will exit regardless.

## Key decisions and findings

### Persona steering rule: discipline-driven, not hardcoded

The generated `golem-prefer-persona-agents.md` now announces each persona via its own `discipline` field (`coder`, `reviewer`, `scribe`, `planner`, etc.) instead of a fixed task-type list wired into the rule template. This makes the steering rule generic — any project's custom persona roster reads correctly without editing the template. The mapping `discipline: ["planning", "architecture"]` → `subagent_type: golem-planner` is read from the persona's own config at generation time.

### Committed persona prompts (.golem/personas/)

Persona prompt text is now gitignore-unblocked by default (`init-hooks.ts`). These are ordinary project content, not per-clone-only secrets. A team can ship a persona via git like any other decision.

### fallbackModel: cheap mitigation for model-access barriers

Claude Code's `fallbackModel` setting is now seeded in `settings-extras.ts` as an array chain per [code.claude.com/docs/en/settings](https://code.claude.com/docs/en/settings). If a contributor lacks access to the pinned model (e.g., `planner` pinned to `claude-opus-5`), `fallbackModel: ["claude-sonnet-5", "claude-haiku-4-5"]` provides a degraded path rather than failing outright. Not a solution, but a graceful one-step-back.

### Rejected: "avoid spawning Node for statusline"

Investigation of whether the 2s refresh rate could be eliminated by having `statusline` HTTP-query the proxy daemon instead of forking Node showed that **the cost is NOT the spawn — it is the telemetry parse** (§167, verification-notes). Replacing the subprocess with a network call does not save that work; it moves it and adds latency. The Node spawn is cheap; the 25MB log parse is not. The daemon watcher polls settings on a 5s timer and stays resident, so a process-per-invocation model remains correct for the (infrequent) actual callers (`code.claude.com` refreshes on manual invoke + event-driven updates, defaulting to every 5s for polling refreshes if a `statusline` command exists). Decision: keep the architecture as-is.

### Telemetry retention as a deliberate trade-off

The bounded-retention scheme (current + 1 prior file) is intentional. It means:
- `golem stats` reporting daily stats ✓
- `golem stats --cache` hit-rate trending over 2 days ✓
- `all`-time statistics unavailable after retention window ✗

This is a follow-up question, not a bug. Unbounded logs grow indefinitely and parsing them dominates CPU; keeping 30 days of detail makes the file ~750MB and keeps the parse at 3–4s even with incremental structure. A user project can override the rotation threshold via `telemetry.log_rotation_bytes` if they need longer retention and can accept the parse cost. Task filed to revisit (9833dd37-74b1-4e7b-80ff-52b220546c9b).

## Measurements

| Metric | Before | After | Context |
|---|---|---|---|
| statusline invocation time | ~900ms | ~450ms | 25MB event log, incremental rollup |
| orphaned processes (Windows) | 55 | 0 | stdin pipe leak fixed; 2.3GB RSS freed |
| system CPU load | ~100% | ~25% | after zombie cleanup |
| test suite (this session) | 43 failures / 15m56s | 0 failures / 2m01s | CPU contention resolved; one stale test assertion also fixed |

## Sources

- **Persona sync:** `src/cli/persona-sync.ts` (shared extraction from init.ts), `src/cli/persona-watcher.ts` (daemon poller), `src/cli/version-sync.ts` (SessionStart hook)
- **Telemetry:** `src/telemetry/jsonl-store.ts` (incremental rollup + rotation logic)
- **Zombie fix:** `src/cli/fast-path.ts` (runStatusline stream teardown + watchdog)
- **Research:** `docs/plan/verification-notes.md` §166 (persona file caching) and §167 (statusline spawn cost rejection)
- **Follow-up:** task 9833dd37-74b1-4e7b-80ff-52b220546c9b (telemetry retention cap revisit)

## Links

- [[Persona Registry]] — the persona system and staffing model
- [[Guidance Rules]] — how `golem-prefer-persona-agents.md` is generated and distributed
- [[Configuration Surfaces]] — where `fallbackModel` and telemetry settings live
