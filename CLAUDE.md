# CLAUDE.md — Golem (golem.run)

Guidance for Claude Code agents working in this repository.

## What this project is
Golem is a universal pre-LLM processing layer (spec Decision 22, positioning confirmed by Decision 32): a local-first **TypeScript** service (proxy + MCP server) providing redaction, compression, local tools, routing, and honest observability in front of LLM traffic. Claude Code is Golem's flagship, most-verified integration — byte-faithful proxying, native MCP tools, an agentic developer-assistant layer with local tools (vector knowledge base, tiered Ollama inference, CCR expansion, telemetry) on developer-grade hardware — with the same pipeline designed to extend to other gateways (Foundry, OpenRouter — R6.1/WS-F14, on hold per Decision 36). Compression is *situational* (Decision 23): it pays on non-caching upstreams, ~0% honest savings on Anthropic's cached traffic today. Onboarding/docs live at https://golem.run; npm package **`golem-run`**, CLI binary **`golem`**.

> **Naming:** the project was renamed from its working title to **Golem** on 2026-07-03 (spec Decision 19; the old name was scrubbed from living docs by Decision 36 — only dated wiki records and old Decisions Log entries may still say "EOL", read them as Golem). Renamed surfaces: `/golem/<cmd>` skills, `/mcp__golem__<cmd>` prompts, `GOLEM_<SECTION>_<KEY>` env, `~/.golem/` + `<project>/.golem/` config, `x-golem-bypass` header. As of Decision 27 (2026-07-09), the 7 MCP tools use short verb names, not `golem_*`: `search`, `fetch`, `expand`, `stats`, `level`, `ingest`, `coder` (formerly `golem_search`, `golem_get_chunk`, `golem_expand`, `golem_stats`, `golem_set_slider`, `golem_index_path`, `golem_delegate`); skills/prompts/env/config/header surfaces are unaffected. **Decision 35** (2026-07-15) further renamed the last of those seven, `delegate` → `coder`, to name its actual scope (code/test drafting); do not rename any of the 7 tool names again without a new Decisions Log entry.

## Source of truth
1. `docs/golem-spec.md` (v1.x) — architecture and decisions. Do not diverge silently; propose spec changes via the Decisions Log. **Decision 16 switched the implementation language to TypeScript (2026-07-03, user decision).**
2. `docs/plan/IMPLEMENTATION_PLAN.md` — workstreams and frozen interfaces; `docs/plan/ROADMAP.md` — release ordering; `docs/plan/BACKLOG.md` — ideas inbox. Planning docs live under `docs/plan/`; completed batch briefs are retired to git history.
3. `docs/plan/verification-notes.md` — dated live-doc findings (T0.1). Check it before building on any external-tool fact.

## Hard rules
- **Interfaces in `src/interfaces/` are frozen contracts.** Changing one requires updating its contract tests and flagging all dependent workstreams in the PR description.
- **Cross-platform always:** native Windows, macOS, Linux. Use `node:path`, `env-paths`, `node:os`; never hardcode `/tmp`, POSIX signals, or shell-specific syntax; spawn processes with argument arrays, not shell strings. CI matrix must pass on all three.
- **The Headroom dependency is pinned exactly.** Never bump the pins outside the T-C4 upgrade playbook. Any Headroom client imports live only in `src/compression/headroom-adapter.ts`; pins live in `src/compression/index.ts`.
- **Never weaken the redaction stage** or reorder it after compression — secrets/PII must be stripped before any content is transformed, stored, or forwarded. **One deliberate exception (Decision 30, USER decision):** slider **level 0 ("passthrough")** is a full bypass where nothing runs, redaction included — a conscious opt-out equivalent to not using the proxy. It is never the default (default is level 1), and it must be surfaced loudly wherever active (`golem slider 0`, `status`, `statusline`, the `level`/`slider`/`bypass` MCP surfaces all warn that redaction is off). Redaction remains mandatory and un-weakenable at every level ≥ 1.
- **Proxy fidelity:** at slider level ≤1, SSE streaming and tool-use blocks pass through byte-faithful. Any pipeline change needs the recorded-shape integration tests to pass.
- **No heavyweight native deps in the default install** — GPU/ML extras are optional add-ons (separate opt-in package or lazy download), never in the core `dependencies`.

## Verify, don't assume
Details about Claude Code (hooks schema, skills/commands, `claude mcp add`), the MCP spec, Headroom's config surface, and Anthropic prompt caching MUST be checked against live docs before implementing against them:
- https://docs.claude.com (Claude Code + API)
- https://headroom-docs.vercel.app/llms.txt and the GitHub repo
Record findings with dates in `docs/plan/verification-notes.md`.

## Conventions
- TypeScript strict (`tsc --noEmit` clean with `"strict": true` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`); Node ≥ 22, ESM only.
- npm for dependency management (`package-lock.json` committed); `npm run lint` (Biome) and `npm run format:check` clean.
- Runtime boundary validation with zod at every external surface (HTTP bodies, MCP params, config files); internal code trusts types.
- Async/streams for I/O paths (proxy, inference, vector DB); keep CPU-bound compression work off the request path's critical latency (worker_threads if needed).
- Tests: vitest, colocated by kind: `tests/contract`, `tests/integration`, `tests/e2e`. Contract tests before implementations.
- Conventional commits; one workstream per PR; PR description lists which interfaces are consumed/affected.
- Config keys are `snake_case` in settings.json; env overrides are `GOLEM_<SECTION>_<KEY>`.

## Multi-agent etiquette
- Claim tasks by IMPLEMENTATION_PLAN ID (e.g., "A2") in the PR title.
- Don't modify files owned by another workstream's directory; request changes through the integrator.
- If blocked on an unresolved unknown (plan §5), write the question in `docs/plan/verification-notes.md` and pick up another task rather than guessing.

## Definition of done (P0 — ✅ met; kept as the standing bar)
See IMPLEMENTATION_PLAN §4. Short version: `npx golem-run init` works on all 3 OSes; proxy is byte-faithful at level ≤1 with real savings at level 1; the `/golem/*` skills and `/mcp__golem__*` prompts function in Claude Code; redaction verified; CI green.

## Batch close-out (run after the last task in a batch)
Don't consider a batch done until these run — dogfooding this repo means the running services and the planning docs must both reflect the new code:
1. **Build & verify green:** `npx tsc --noEmit`, `npm run lint`, `npm run format:check`, `npx vitest run` — and `golem wiki check` if any wiki page changed.
2. **Deploy locally** (so the *running* processes pick up the rebuild — see the deploy notes): `npm run build` → `golem proxy restart` → note that any live `golem mcp serve` connection must be reconnected by Claude Code → `cd vscode-extension && npm run deploy:local` + "Developer: Reload Window" **only if** extension files changed. Restarting matters: e.g. a proxy/MCP change is invisible until the daemon/connection restarts.
3. **Tidy the planning docs:** mark tasks done in `ROADMAP.md` (empty the loose-ends table when you can) and write the dated `docs/wiki/debriefs/` page (plan-gated). **Retire the batch brief:** a batch brief is committed to git while its batch runs, then **deleted once the batch lands** — completed briefs are never kept in the tree (git history preserves them; precedent: R1–R5 + PRE-R6 were retired). Update any living-doc references (CLAUDE.md, ROADMAP, IMPLEMENTATION_PLAN, spec) to point at git history / shipped artifacts; dated wiki debriefs keep their point-in-time references. Record any spec Decisions Log change.
4. **Commit & PR:** conventional commits on a branch (never commit straight to `main`), one workstream per PR, PR body lists affected interfaces. **Use the `gh` CLI** for PR operations (`gh pr create`, `gh pr merge --squash`) — squash-merge to match the repo's `(#N)` history.
