# CLAUDE.md — EOL (Edge Offload Layer)

Guidance for Claude Code agents working in this repository.

## What this project is
EOL is an agentic developer-assistant layer for Claude: a local-first **TypeScript** service (proxy + MCP server) that cuts token spend via embedded Headroom compression and gives Claude local tools — vector knowledge base, tiered Ollama inference, CCR expansion, telemetry — on developer-grade hardware.

## Source of truth
1. `docs/edge-offload-spec.md` (v1.x) — architecture and decisions. Do not diverge silently; propose spec changes via the Decisions Log. **Decision 16 switched the implementation language to TypeScript (2026-07-03, user decision)** — read any residual Python phrasing in older doc sections through that lens.
2. `docs/IMPLEMENTATION_PLAN.md` — workstreams, frozen interfaces, task order.
3. `docs/verification-notes.md` — dated live-doc findings (T0.1). Check it before building on any external-tool fact.

## Hard rules
- **Interfaces in `src/interfaces/` are frozen contracts.** Changing one requires updating its contract tests and flagging all dependent workstreams in the PR description.
- **Cross-platform always:** native Windows, macOS, Linux. Use `node:path`, `env-paths`, `node:os`; never hardcode `/tmp`, POSIX signals, or shell-specific syntax; spawn processes with argument arrays, not shell strings. CI matrix must pass on all three.
- **The Headroom dependency is pinned exactly.** Never bump the pin outside the T-C4 upgrade playbook. All Headroom imports live only in `src/compression/headroom-adapter.ts` (plus the memory wiring module in `src/knowledge/` if Decision 13 memory federation lands there).
- **Never weaken the redaction stage** or reorder it after compression — secrets/PII must be stripped before any content is transformed, stored, or forwarded.
- **Proxy fidelity:** at slider level ≤1, SSE streaming and tool-use blocks pass through byte-faithful. Any pipeline change needs the recorded-shape integration tests to pass.
- **No heavyweight native deps in the default install** — GPU/ML extras are optional add-ons (separate opt-in package or lazy download), never in the core `dependencies`.

## Verify, don't assume
Details about Claude Code (hooks schema, skills/commands, `claude mcp add`), the MCP spec, Headroom's config surface, and Anthropic prompt caching MUST be checked against live docs before implementing against them:
- https://docs.claude.com (Claude Code + API)
- https://headroom-docs.vercel.app/llms.txt and the GitHub repo
Record findings with dates in `docs/verification-notes.md`.

## Conventions
- TypeScript strict (`tsc --noEmit` clean with `"strict": true` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`); Node ≥ 22, ESM only.
- npm for dependency management (`package-lock.json` committed); `npm run lint` (Biome) and `npm run format:check` clean.
- Runtime boundary validation with zod at every external surface (HTTP bodies, MCP params, config files); internal code trusts types.
- Async/streams for I/O paths (proxy, inference, vector DB); keep CPU-bound compression work off the request path's critical latency (worker_threads if needed).
- Tests: vitest, colocated by kind: `tests/contract`, `tests/integration`, `tests/e2e`. Contract tests before implementations.
- Conventional commits; one workstream per PR; PR description lists which interfaces are consumed/affected.
- Config keys are `snake_case` in settings.json; env overrides are `EOL_<SECTION>_<KEY>`.

## Multi-agent etiquette
- Claim tasks by IMPLEMENTATION_PLAN ID (e.g., "A2") in the PR title.
- Don't modify files owned by another workstream's directory; request changes through the integrator.
- If blocked on an unresolved unknown (plan §6), write the question in `docs/verification-notes.md` and pick up another task rather than guessing.

## Definition of done (P0)
See IMPLEMENTATION_PLAN §5. Short version: `npx eol init` works on all 3 OSes; proxy is byte-faithful at level ≤1 with real savings at level 1; the `/eol/*` skills and `/mcp__eol__*` prompts function in Claude Code; redaction verified; CI green.
