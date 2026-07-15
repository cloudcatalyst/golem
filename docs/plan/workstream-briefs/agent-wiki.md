# Workstream brief — agent-wiki (WS-W: wiki knowledge store, Decision 28)

Read `CLAUDE.md` first; it binds. Spec: `docs/edge-offload-spec.md` Decision 28.
Design doc: `docs/plan/proposals/wiki-knowledge-pivot.md`. The wiki's own schema
(`docs/wiki/WIKI.md`) is both a live example and the template you will ship.
Work on branch `ws-w`; claim tasks by ID in PR titles (e.g. "W1a: ...").

> **Draft locally first.** Before writing any code, draft each unit (function,
> template, test skeleton) via the `coder` MCP tool (local model) and refine the
> draft — don't burn upstream tokens on first drafts. Same for commit messages.

## Mission
W1: make the project wiki exist (`golem wiki init`), make it configurable
(`knowledge.wiki_dir`, default `docs/wiki`), and make Claude find it first
(search-rank boost + wiki-first guidance). No new frozen interfaces in W1;
`src/interfaces/knowledge.ts` MUST NOT change. The existing auto-index
(`src/cli/auto-index.ts`, runs on `golem mcp serve` startup) already picks up
markdown under the project root, so a scaffolded wiki is indexed with zero extra
wiring — W1 is config + scaffold + rank + guidance.

## Task list (in order) — exact seams

- **W1a — `wiki_dir` setting.** `src/config/schema.ts`: add leaf
  `wiki_dir: z.string()` to `SETTINGS_LEAVES.knowledge`, field
  `readonly wiki_dir: string` to `KnowledgeSettings`, and `wiki_dir: "docs/wiki"`
  to `DEFAULT_SETTINGS.knowledge`. That one table drives the loader, env mapping
  (`GOLEM_KNOWLEDGE_WIKI_DIR` — derived, no env.ts change), and `writeSetting`.
  Make it required-with-default, NOT optional (`exactOptionalPropertyTypes` pain).
  A relative value is project-rooted; absolute values allowed — resolve with
  `node:path` (`path.isAbsolute`), mirroring `resolveIndexPaths` in
  `src/cli/auto-index.ts:55`. Update any config tests that enumerate leaf paths.

- **W1b — `golem wiki init`.** CLI is commander (`src/cli/main.ts`; see the
  `program.command("init")` block at :78 and the `mcp` subcommand group at :364 for
  the two patterns). Add a `wiki` command group with an `init` subcommand
  (`--dir <path>` option like the others) dispatching to a new `src/cli/wiki.ts`.
  Scaffold `<wiki_dir>/`: `WIKI.md` + `concepts/ entities/ sources/ syntheses/
  decisions/ debriefs/ questions/ artifacts/` (empty dirs get `.gitkeep`).
  Template: generalize `docs/wiki/WIKI.md` (drop the repo-specific Index entries
  and the "this repo's Decisions Log" clause; keep zones/rules/frontmatter spec).
  Idempotent: never overwrite an existing file — report per-path actions with the
  `InitAction` kind pattern from `src/cli/init.ts` (`create`/`skip`). All paths via
  `node:path`; no shell.

- **W1c — wiki hits rank first.** `src/mcp/server.ts`, `search` tool handler
  (registerTool "search", ~:354; `knowledge.search(...)` at ~:392). After search,
  re-rank: a hit whose `chunk.sourcePath` sits under the resolved `wiki_dir` gets a
  multiplicative boost (suggest ×1.25, constant with rationale) before the sort; at
  equal similarity a wiki page must beat a raw chunk. Path-prefix check must be
  separator-safe cross-platform (`path.relative` + not-`..`-prefixed — don't
  `startsWith` raw strings). You'll need the resolved wiki dir in
  `GolemMcpServerDeps` — follow how `defaultProjectId` gets there from
  `golem mcp serve` in `src/cli/main.ts`. Keep `src/knowledge/` generic: the boost
  is MCP-layer policy, not KB behavior.

- **W1d — wiki-first guidance.** `src/hooks/guidance.ts`
  `golemGuidanceSection()`: rewrite the "knowledge base — search before you fetch"
  section to a wiki-first ladder: (1) look in the project wiki (`wiki_dir`,
  default `docs/wiki` — pages are curated and citable), (2) `search` MCP tool
  (wiki pages rank first; use `fetch` for full text), (3) only then
  WebFetch/external docs; keep the cached-URL sentence. The section is
  marker-fenced and idempotently upserted, so re-running `golem init` rolls it out
  — update the `upsertGuidance` tests/snapshots to the new wording. Also mention
  the wiki in the generated `/golem/search` skill text if it references lookup
  order (`src/cli/skills.ts` — check, don't assume).

## Tests (contract-first conventions; vitest, colocated)
- `tests/unit/config/`: `wiki_dir` leaf validates/coerces; default + env override.
- `tests/unit/cli/wiki.test.ts`: scaffold in a tmp dir (fresh / partial / rerun →
  idempotent skips); respects configured relative + absolute `wiki_dir`.
- `tests/unit/mcp/` (or integration `mcp-knowledge.test.ts` style, see
  `tests/integration/mcp-knowledge.test.ts` for the fake-deps pattern): equal-score
  wiki vs non-wiki hit → wiki first; boost inert when no hit is under `wiki_dir`;
  Windows-style separators in `sourcePath` still match.
- `tests/unit/hooks/`: guidance upsert produces the new section, stays idempotent.

## Files owned
`src/cli/wiki.ts` (new), plus the surgical edits above in `src/config/schema.ts`,
`src/cli/main.ts`, `src/mcp/server.ts`, `src/hooks/guidance.ts`, and their tests.
Do NOT touch `src/interfaces/` (frozen), `src/compression/`, or the proxy pipeline.

## Definition-of-done slice (W1)
1. `npm run lint`, `npm run format:check`, `tsc --noEmit`, and the vitest suites
   green (all 3 OSes in CI).
2. In a scratch project: `golem wiki init` scaffolds `docs/wiki`; rerun is all
   skips; `GOLEM_KNOWLEDGE_WIKI_DIR=notes golem wiki init` scaffolds `notes/`.
3. `golem mcp serve` indexes the wiki (auto-index, no new wiring); a `search` for a
   term present in both a wiki page and a raw doc returns the wiki page first.
4. `golem init` (rerun) rewrites the guidance section with the wiki-first ladder.
5. This repo dogfoods it: run the rebuilt CLI here and confirm `docs/wiki` pages
   surface first for "wiki-first knowledge".

## W2 — done 2026-07-10
Its four open autonomy questions (`docs/wiki/questions/wiki-write-autonomy.md`)
were resolved ahead of implementation via spec Decision 29, unblocking the
work without a separate integrator round-trip. Shipped: frozen
`src/interfaces/wiki.ts` (`WikiReader`/`WikiStore`, contract tests first) +
`FileWikiStore`; `wiki_read`/`wiki_upsert` MCP tools (plan-gated writes, per
Decision 29 — doc-level gating, no in-protocol confirmation step) wired into
`golem mcp serve`; `/golem/wiki-ingest <url>` + `/golem/wiki-query` (renamed
`research`, Decision 35) skills
under `.claude/skills/golem/`; `golem wiki check` frontmatter/date/wikilink/
duplicate-title lint (`src/cli/wiki.ts`). Contract, unit, and MCP integration
tests all green; see Decision 29 for the concrete `upsertPage` write
semantics (append-and-refine + tag/source union-merge +
`WikiWriteConflictError` on title/type mismatch).
