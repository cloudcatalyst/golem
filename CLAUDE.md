# CLAUDE.md — Golem (golem.run)

Guidance for Claude Code agents working in this repository.

## What this project is
Golem is a universal pre-LLM processing layer (spec Decision 22, positioning confirmed by Decision 32): a local-first **TypeScript** service (proxy + MCP server) providing redaction, compression, local tools, routing, and honest observability in front of LLM traffic. Claude Code is Golem's flagship, most-verified integration — byte-faithful proxying, native MCP tools, an agentic developer-assistant layer with local tools (vector knowledge base, tiered Ollama inference, CCR expansion, telemetry) on developer-grade hardware — with the same pipeline designed to extend to other gateways (Foundry, OpenRouter — R6.1/WS-F14, on hold per Decision 36). Compression is *situational* (Decision 23): it pays on non-caching upstreams, ~0% honest savings on Anthropic's cached traffic today. Onboarding/docs live at https://golem.run; npm package **`golem-run`**, CLI binary **`golem`**.

> **Naming:** the project was renamed from its working title to **Golem** on 2026-07-03 (spec Decision 19; the old name was scrubbed from living docs by Decision 36 — only dated wiki records and old Decisions Log entries may still say "EOL", read them as Golem). Renamed surfaces: `/golem/<cmd>` skills, `/mcp__golem__<cmd>` prompts, `GOLEM_<SECTION>_<KEY>` env, `~/.golem/` + `<project>/.golem/` config, `x-golem-bypass` header. As of Decision 27 (2026-07-09), the 7 MCP tools use short verb names, not `golem_*`: `search`, `fetch`, `expand`, `stats`, `level`, `ingest`, `coder` (formerly `golem_search`, `golem_get_chunk`, `golem_expand`, `golem_stats`, `golem_set_slider`, `golem_index_path`, `golem_delegate`); skills/prompts/env/config/header surfaces are unaffected. **Decision 35** (2026-07-15) further renamed the last of those seven, `delegate` → `coder`, to name its actual scope (code/test drafting); do not rename any of the 7 tool names again without a new Decisions Log entry.

## Source of truth
1. `docs/golem-spec.md` (v1.x) — architecture and decisions. Do not diverge silently; propose spec changes via the Decisions Log. **Decision 16 switched the implementation language to TypeScript (2026-07-03, user decision).**
2. `docs/plan/IMPLEMENTATION_PLAN.md` — workstreams and frozen interfaces; `docs/plan/ROADMAP.md` — release ordering (current batch: `docs/plan/R4_BATCH.md`). Planning docs live under `docs/plan/`.
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

<!-- golem:begin -->
## Golem: how to work in this project (defaults — do these proactively)

This project runs Golem. The practices below are the DEFAULT way to work
here: apply them on your own initiative, every time they fit — you do not
need the user to ask for them. They keep paid-model tokens for the judgment
calls only you can make.

## Golem: oversized tool outputs are swapped for CCR refs

This project runs Golem (golem.run). A PostToolUse hook replaces oversized
tool outputs (Bash, Read, Grep, Glob, WebFetch) with a compact digest:
head/tail excerpts, byte/line counts, and a lossless reference marker like
`Retrieve original: hash=<64-hex-id>`. The full original is stored locally
under `.golem/ccr` — nothing is lost.

When the excerpt is not enough, expand the reference:

- call the `expand` MCP tool with `ref_id` set to the hex id, or
- use `/golem/expand <id>` (or `/mcp__golem__expand <id>`).

Expand only when needed — the full original re-enters context and costs
the tokens the swap saved. Prefer re-running a narrower command (grep the
file, limit the range) when you only need a small part.

## Golem: wiki-first knowledge (spec Decision 28)

This project keeps a durable, committed wiki (default `docs/wiki/` — see its
`WIKI.md` for the exact zones and write rules; the configured location may
differ, check `knowledge.wiki_dir` if unsure). Wiki pages are the source of
truth; Golem's local vector index — which also covers ingested source trees,
this project's other `.md` docs, and every page fetched with WebFetch — is
just a derived, rebuildable cache over them.

At the start of a session, skim the wiki's own `WIKI.md` Index once — it's
cheap and tells you what's already known before you duplicate a search. Then
follow this ladder before reaching outside the project:

1. **Check the wiki first.** Look for an existing page on the topic (start
   from the wiki's `WIKI.md` index).
2. **No page? Search next.** Call the `search` MCP tool (or `/golem/research`)
   with your query — it tries an exact wiki-title / one-hop-wikilink match
   before vector search, and wiki pages rank above other hits; use `fetch`
   for a hit's full text.
3. **Still nothing? Then WebFetch or external docs.** A previously-fetched
   URL is served from the cache automatically (the fetch is skipped and the
   cached content is returned), so re-fetching the same page is free and
   offline — the same goes for files brought in with the `ingest` tool and
   ideas captured with `golem note`.
4. **Learned something worth keeping?** A raw capture (a fetched page, an
   ingested file, a captured note) is searchable but disconnected — it has
   no place in the graph until it's a wiki page. Propose adding or updating
   a page rather than letting the capture evaporate or sit as an orphaned
   chunk; cite the raw source and add real `[[wikilinks]]` to every related
   page it belongs with, so graph traversal (not just similarity search)
   can find it later. Wiki writes are plan-gated (propose, get approval,
   then write).

## Golem: prefer the local model for coding drafts

By default, before writing non-trivial code, draft it with the `coder` MCP
tool first — a local model — then review and refine the result yourself
rather than writing from scratch. Do this proactively; you don't need to be
asked. It leaves the paid model's tokens for the judgment calls the local
model can't make: review, integration, and anything genuinely hard. The
local model is engaged only by explicit acts — `coder` (drafting), `golem
task run` (servicing queued tasks), and (when enabled) `golem prompt
translate`; the slider is a compression dial only and never auto-engages
the model (Decision 31). Use `coder` at every level; skip it only when the
task is too small for the round trip to pay off.
<!-- golem:end -->
