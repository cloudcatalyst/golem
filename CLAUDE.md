# CLAUDE.md — Golem (golem.run)

Guidance for Claude Code agents working in this repository.

## What this project is
A local-first TypeScript pre-LLM processing layer (proxy + MCP server): redaction, compression, local tools, routing, honest observability. Claude Code is the flagship integration — byte-faithful proxying, native MCP tools, agentic developer-assistant with local tools (vector KB, tiered Ollama inference, CCR expansion, telemetry). The pipeline extends to other gateways (R6.1). npm **`golem-run`**, CLI **`golem`**.

Previously the project had a different working title — dated wiki records still show it, read as Golem. The 7 MCP tools use short verb names: `search`, `fetch`, `expand`, `stats`, `level`, `ingest`, `coder` (Decisions 27/35). Skills/prompts/env/config/header use `/golem/<cmd>` and `GOLEM_*`.

## Source of truth
1. `docs/golem-spec.md` — architecture, decisions, ADR log
2. `docs/plan/tasks/` — one committed task doc per open item. Start here: `golem task index --summary`
3. `docs/plan/verification-notes.md` — dated live-doc findings, check before building on external-tool facts
4. `docs/plan/ROADMAP.md` — generated index over tasks, never hand-edit

## Golem tasks workflow
```
golem task index --summary     # what's ready, what's blocked
golem task show <id>           # full brief for one item
golem task list                # both scopes; --plan / --local to narrow
golem task done <id> --note …  # close it (then regenerate index)
golem task index --write       # regenerate ROADMAP.md
golem task add                 # capture new work inline
```
- Task doc is the unit of dispatch — hand it whole to a fresh agent
- `owner: user` → agent must not do it (outward-facing or credentialed)
- `blocked` is metadata (task stays `queued` for visibility)
- Park at limit: call `snooze` with `note` — never try `golem task add` first
- New work → new task doc in `docs/plan/tasks/` per `README.md`

## Hard rules
- `src/interfaces/` are frozen contracts — update tests + flag dependent workstreams
- Cross-platform always: `node:path`, `env-paths`, argument-array spawn
- Headroom pinned exactly; imports only in `src/compression/headroom-adapter.ts`
- Redaction must never be weakened or reordered. Level 0 is the single exception (full bypass, never default, surfaced loudly)
- Proxy byte-faithful at ≤ level 1. Pipeline changes need recorded-shape tests
- No heavyweight native deps in default install — GPU/ML are optional add-ons

## Verify, don't assume
Check live docs for Claude Code (hooks, skills, `claude mcp add`), MCP spec, Headroom config, and Anthropic prompt caching before implementing: docs.claude.com, headroom-docs.vercel.app + GitHub repo. Record findings with dates in `docs/plan/verification-notes.md`.

## Conventions
TypeScript strict, ESM, Node ≥ 22. npm, Biome lint + format. Zod at external boundaries, trust types internally. Async/streams for I/O, worker_threads for CPU-bound off critical path. Vitest, colocated by kind. Conventional commits, one workstream per PR.

## Multi-agent
Claim tasks by ID in PR title. Don't modify files owned by another workstream. Blocked? Write the question in verification-notes and pick up another task.

## Batch close-out
Run `/golem/ship` after the last task in a batch: verify green, rebuild + restart, tidy planning docs, write debrief, retire batch brief, commit + PR.