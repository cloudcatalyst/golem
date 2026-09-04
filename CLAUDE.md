# CLAUDE.md — Golem (golem.run)

Guidance for Claude Code agents working in this repository.

## What this project is
A local-first TypeScript pre-LLM processing layer (proxy + MCP server): redaction, compression, local tools, routing, honest observability. Claude Code is the flagship integration — byte-faithful proxying, native MCP tools, agentic developer-assistant with local tools (vector KB, tiered Ollama inference, CCR expansion, telemetry). The pipeline extends to other gateways (R6.1). npm **`golem-run`**, CLI **`golem`**.

Previously the project had a different working title — dated wiki records still show it, read as Golem. The MCP tools use short verb names: `search`, `fetch`, `expand`, `stats`, `ingest`, `coder` (Decisions 27/35). `level` was retired with the slider (ADR-0004): no tool call can change how much of the pipeline runs. Skills/prompts/env/config/header use `/golem/<cmd>` and `GOLEM_*`.

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
- Redaction must never be weakened or reordered. `proxy.bypass_all` is the single exception (full bypass, never default, CLI-only, surfaced loudly — ADR-0004). No dial value can disable it
- Proxy byte-faithful at compression ≤ 1. Pipeline changes need recorded-shape tests
- No heavyweight native deps in default install — GPU/ML are optional add-ons

## Verify, don't assume
Check live docs for Claude Code (hooks, skills, `claude mcp add`), MCP spec, Headroom config, and Anthropic prompt caching before implementing: docs.claude.com, headroom-docs.vercel.app + GitHub repo. Record findings with dates in `docs/plan/verification-notes.md`.

## Conventions
TypeScript strict, ESM, Node ≥ 22. npm, Biome lint + format. Zod at external boundaries, trust types internally. Async/streams for I/O, worker_threads for CPU-bound off critical path. Vitest, colocated by kind. Conventional commits, one workstream per PR.

## Branches and releases
```
working branch → PR → development → "Prepare release" → PR → main → release published
```
- **PRs target `development`, never `main`.** `main` receives release PRs only, so every merge into it IS a release (tag, GitHub Release, binaries, npm tarball, `install.sh`, `install.ps1`, `config-schema.json`, portal webhook).
- **CI gates every PR** — into `development` and into `main`. Ubuntu + Windows are blocking; macOS is advisory until it has been green a few times. `golem verify` green by **exit code** stays the local bar before you push (don't pipe it — the pipe's exit code is not the gate's).
- Cut a release with the **Prepare release** workflow on `development` — it bumps the version and opens the release PR. Never hand-edit a version; `scripts/release.mjs` moves `package.json`, `vscode-extension/package.json` and the compiled-in `VERSION` together.
- **Merge the release PR with a merge commit, not squash** — a squash rewrites the history `development` is built on.
- Full design: `docs/wiki/concepts/Release Pipeline.md`.

## Multi-agent
Claim tasks by ID in PR title. Don't modify files owned by another workstream. Blocked? Write the question in verification-notes and pick up another task.

## Batch close-out
Run `/golem/ship` after the last task in a batch. Checklist:

- [ ] Verify green: `tsc --noEmit`, `biome check`, `npm run verify:deps`, `vitest run`
- [ ] Rebuild + restart proxy/CLI
- [ ] Add a **`docs/plan/SHIPPED.md`** row — that exact path is the ONLY shipped log; never create another
- [ ] Write **wiki debrief** under `docs/wiki/debriefs/` (outcome, key lessons, sources, tags)
- [ ] Commit close-out docs alongside the work
- [ ] `golem task done <id> --note "shipped"`
- [ ] `golem task index --write` → regenerate ROADMAP.md
- [ ] Retire batch brief, commit + PR
- [ ] **Before merging: `gh pr checks <n>` must show `CI gate` green.** Skipping it is how CI stayed red for four consecutive merges. **Reinstated 2026-09-04** — the 2026-08-22 billing block cleared (last billing failure 2026-08-29, Actions running normally since 2026-09-02).
  - **If jobs fail in 1–5s with no steps, that is a BILLING BLOCK, not a regression.** *"The job was not started because recent account payments have failed or your spending limit needs to be increased"*. No code ran, so the red says nothing about the change. Read the run's **annotations** (`gh run view <id>`), not the logs — the logs do not exist, and `gh run view --log` answers `log not found`, which reads like a tooling fault. It cannot be detected from inside a workflow: the workflow never starts.
  - **When it happens, the gate moves local, it does not disappear.** Run and report in the PR: `golem verify` (or `npx tsc --noEmit` · `npm run lint` · `npm run format:check` · `npx vitest run` · `golem wiki check`) — judged by **exit codes**, not tailed output, pasting the suite totals. Merging on a green local run is allowed; merging on an unrun one is not.