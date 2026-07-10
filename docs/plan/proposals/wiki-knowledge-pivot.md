# Proposal — Wiki-first knowledge: pages as the store, vectors as the index

**Status:** ACCEPTED (2026-07-10, USER DECISION — adopted as spec Decision 28).
User refinements at acceptance: wiki location is **configurable (`wiki_dir`), default
`docs/wiki`**; planning documents (implementation plan, workstream briefs, proposals)
move to **`docs/plan/`**. Tasks tracked as workstream WS-W in the implementation plan.

**Inspiration:** Roan Brasil Monteiro, *"Building a Complete Personal Harness: LLM Wiki
+ Developer's Second Brain in Obsidian"* (Medium, fetched 2026-07-10, in the web cache).
Golem adopts the pattern's substance — zoned plain-markdown wiki, agent-maintained
concept pages, plan-gated ingestion, wikilink graph — **without Obsidian**: plain files
that any editor (including Obsidian, if a user wants it) can open.

---

## 1. What changes conceptually

Today Golem's knowledge is **chunks-primary**: sources (repo docs, fetched pages) are
chunked, embedded, and stored in a per-project vector index (`.golem/knowledge`). The
index *is* the knowledge — opaque, machine-readable, per-machine, not shareable, and
regenerable only from sources that may have scrolled away (a fetched URL, a
conversation insight).

This proposal inverts that: **pages are primary, the vector index is derived.**

| | Today (chunks-primary) | Proposed (wiki-first) |
|---|---|---|
| Canonical store | vector index (`.golem/knowledge`) | markdown wiki pages in the repo |
| Human-readable | no | yes — doubles as project documentation |
| Shareable/committable | no (per-machine binary-ish state) | yes — `git add wiki/` |
| Vector index | source of truth | disposable cache, rebuildable from pages + sources at any time |
| Retrieval | semantic search only | title/link graph first, semantic search as fallback + discovery |
| Fetched web content | chunked into the index | raw → local cache (as today); **distilled** → wiki page |
| Loss on index corruption | knowledge gone | nothing — `golem wiki reindex` |

The frozen `KnowledgeBase` contract (`src/interfaces/knowledge.ts`) is **untouched**:
the wiki is a new durable layer *underneath* it. Wiki pages are just markdown files —
`ingest()` indexes them like any other doc tree (with a watcher), `search()` finds
them, `getChunk()` returns page sections. No interface change, no contract-test churn.

## 2. Is the vector database still relevant?

**Yes — demoted, not deleted.** Three retrieval needs remain that a wiki graph can't
serve:

1. **Code.** The wiki holds *knowledge about* the project; it never mirrors code.
   Function/class-granularity code search stays vector-only (WS-C C2).
2. **Discovery without a title.** "What do we know about SSE backpressure?" when no
   page is named that. Semantic search over page chunks finds it; grep-based lookup
   (the article's approach) only scales to a few hundred well-titled notes.
3. **Raw capture.** Fetched pages, CCR-swapped outputs, clippings — high-volume,
   unrefined, never worth hand-linking. Vector search is the only practical recall.

What the vector DB **loses** is its source-of-truth status. It becomes a rebuildable
projection — which also dissolves the schema-migration anxiety around
`KNOWLEDGE_SCHEMA_VERSION`: migrate by reindex, not by data surgery. `.golem/knowledge`
stays gitignored; the wiki is what travels.

Retrieval becomes **graph-first, vector-second**:

```
query ──▶ 1. exact/alias page-title + wikilink-graph lookup   (cheap, precise, no embed)
      └─▶ 2. federated vector search (wiki pages boosted > raw > code, per metadata)
```

Both steps stay behind the existing `search` MCP tool — Claude's calling convention
does not change; results get better and start returning human-auditable pages.

## 3. Layout and zones

Adapting the article's three zones to Golem's automation-heavy reality. Location is
configurable — `wiki_dir` in project settings (`snake_case`; env override
`GOLEM_KNOWLEDGE_WIKI_DIR`) — **default `docs/wiki`**, so knowledge sits beside the
rest of the project's documentation:

```
<project>/
  docs/wiki/                     # ZONE 2+3 — committable, the shared knowledge store
    WIKI.md                      #   zone-0 schema: conventions, write rules, index
    concepts/<Title Case>.md     #   agent-maintained concept pages
    entities/<Title Case>.md     #   tools, libraries, services, people
    sources/<slug>.md            #   distilled summaries of fetched pages/articles (cite URL)
    syntheses/<slug>.md          #   cross-document write-ups
    decisions/ADR-NNNN-<slug>.md #   collaborative — human drives, agent co-pilots
    debriefs/YYYY-MM-DD-<slug>.md
    questions/<slug>.md          #   open questions (plan §6 unknowns can live here)
    artifacts/<slug>.md          #   distilled/durable Claude artifacts worth keeping
  .golem/                        # ZONE 1 — machine capture, local-only, gitignored
    webcache/                    #   raw fetched pages (exact-URL, TTL) — unchanged
    ccr/                         #   oversized-output store — unchanged
    knowledge/                   #   derived vector index — unchanged location, new status

~/.golem/wiki/                   # user-scope personal wiki (cross-project)
```

- **Zone 1 (raw) is Golem's capture machinery, not a human clippings folder.** The
  article makes `raw/` human-curated; Golem's raw layer is automated (webcache, CCR)
  and already exists. It stays local: raw fetched full-text is both bulky and a
  **copyright/PII hazard to commit**. Redaction-before-storage (hard rule) already
  covers it; the *distilled* source note — facts, in our words, citing the URL — is
  what enters the committable wiki.
- **Zone 2 (wiki) is agent-maintained, plan-gated.** The agent proposes page
  creations/updates and applies them only after the plan is approved (or, later, under
  an explicit per-project autonomy setting — Decision 20d's gate model applies).
  Append-and-refine, never wholesale rewrite; every page carries frontmatter
  (`title, type, tags, sources, created, updated`) and ≥1 wikilink.
- **Zone 3 (dev: ADRs/debriefs) is collaborative.** For the Golem repo itself the
  spec's Decisions Log remains authoritative; `wiki/decisions/` is for *user projects*
  that lack one. Rule against duplicated truth: **the wiki never restates what the
  code, docs/, or git history already record — it links to them.**
- **User scope (`~/.golem/wiki/`)** is the Decision 20e "user tier" made concrete:
  personal, cross-project knowledge, federated into search alongside the project wiki.
  Workspace/org sync later syncs *markdown files*, not embeddings — simpler and
  auditable, and it sidesteps 20e's "privacy of shared embeddings" open question.

Format is deliberately Obsidian-compatible (wikilinks `[[Title]]`, YAML frontmatter,
kebab-case tags) so users get graph tooling for free if they want it, but nothing in
Golem depends on Obsidian.

## 4. Data flow

```
WebFetch ──PostToolUse hook──▶ redact ──▶ webcache (raw, exact-URL)      [exists]
                                   └────▶ vector index (raw scope)        [exists]
                                   └────▶ distill queue                   [NEW]

distill queue ──local model (delegate/WS-D) or Claude skill──▶
    draft: source note + concept-page diffs + proposed wikilinks
    ──plan approval──▶ wiki/ pages written ──watcher──▶ vector index      [NEW]

notes/ideas (CLI `golem note`, MCP, hook — Decision 20f) ──▶ same distill path
Claude artifacts worth keeping ──▶ wiki/artifacts/ via the same gate
```

Answering the "maybe web fetches and artefacts are stored as chunks" question directly:
**store pages, not chunks.** Chunks are an *index-time* representation derived from
pages/sources; making them the storage unit is what created the current opacity. A
fetched page is stored twice, at two refinement levels: raw full-text in the webcache
(exact recall, offline re-serve — unchanged) and a distilled source note in the wiki
(shared, linked, durable). Artifacts likewise: the durable insight goes to
`wiki/artifacts/`; the raw HTML can sit in CCR/webcache if bulk retention matters.

**Local-model synergy (the economic argument):** the article budgets $20–50/month of
Claude tokens for ingestion. Golem's WS-D tiered Ollama inference runs extraction and
drafting (summarizer/extractor roles, P2) locally at ~zero marginal cost, with Claude
reviewing at plan-approval. Wiki maintenance becomes the flagship consumer of the
`delegate` tool.

## 5. Claude's first port of call

- CLAUDE.local.md guidance (and the `/golem/*` skills) shifts from "search the KB
  before WebFetch" to: **wiki lookup → federated search → then the outside world**,
  with results that are pages a human can open, verify, and correct.
- MCP surface: `search`/`fetch`/`ingest` unchanged. Add (P2, after spike):
  `wiki_read` (page by title/link, follows aliases), `wiki_upsert` (plan-gated
  create/append), and skills `/golem/wiki-ingest <url>`, `/golem/wiki-query`,
  `/golem/note`.
- The `/wiki-query` behavior contract from the article carries over: cite pages via
  wikilinks, flag inference vs. sourced fact, admit gaps rather than fabricate.

## 6. What this does NOT change

- `src/interfaces/knowledge.ts` — frozen, untouched. Wiki tools get their own new
  interface (`src/interfaces/wiki.ts`) when built, with contract tests first.
- Proxy, compression, redaction order, slider — unaffected.
- webcache/CCR mechanics — unaffected (they gain the "zone 1" name, nothing else).
- The default install stays pure-TS; no new native deps.

## 7. Phasing

- **W1 (small, immediately useful):** `golem wiki init` scaffolds `wiki_dir` (default
  `docs/wiki/`) + `WIKI.md`;
  wiki dir auto-ingested with watcher (existing machinery); search ranking boosts
  `kind=wiki-page` metadata; CLAUDE.local.md/skills updated to make the wiki the first
  port of call. *No new interfaces — this is configuration + a scaffold.*
- **W2:** `/golem/wiki-ingest` + plan-gated write path (`wiki_upsert`), Claude-driven
  (works before WS-D lands). Distilled source notes for new fetches.
- **W3 (post WS-D):** local-model distillation queue; `golem note` capture (20f);
  backfill distillation over the existing webcache; graph-first lookup step.
- **W4:** user-scope wiki federation (20e local tier); weekly synthesis reports.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Agent writes plausible-but-wrong pages ("polished hallucination") | plan-before-write gate; frontmatter `sources` required; git history is the rollback; zone rules in WIKI.md |
| Committed wiki leaks secrets/PII or copyrighted full-text | redaction runs before any wiki write (existing hard rule); raw full-text never leaves zone 1; distilled notes cite, don't mirror |
| Wiki duplicates and then contradicts code/docs | hard rule: link, don't restate; contradictions reported to the human, never auto-resolved (per the article's ADR rule) |
| Graph rot (broken wikilinks) as pages move | `golem wiki check` lint (backlink integrity) in CI for the wiki dir |
| Two-store drift (wiki vs. index) | index is a cache: watcher keeps it warm, `golem wiki reindex` rebuilds it from scratch, and nothing reads the index as truth |

## 9. Decision 28 (adopted 2026-07-10 — canonical text lives in the spec Decisions Log)

> **28. Wiki-first knowledge store (v1.11, 2026-07-10, USER DECISION).**
> The durable form of Golem knowledge is a zoned, committable markdown wiki
> (configurable `wiki_dir`, default `<project>/docs/wiki/`; user scope
> `~/.golem/wiki/`): agent-maintained concept/entity/source/synthesis pages with
> frontmatter + wikilinks, plan-gated writes, Obsidian-compatible but
> tool-independent. The vector store (Decision 17) is demoted to a derived,
> rebuildable retrieval index over wiki + raw capture + code; webcache/CCR
> become the local-only "raw" zone. Raw fetched full-text is never committed; distilled
> source notes are. `KnowledgeBase` (frozen) is unchanged; wiki authoring lands behind
> a new frozen `src/interfaces/wiki.ts` with contract tests first. Extends Decisions
> 20e (user tier = local wiki; org sync ships markdown, not embeddings) and 20f
> (note capture targets the wiki). Planning docs relocate to `docs/plan/`. Phases
> W1–W4 per `docs/plan/proposals/wiki-knowledge-pivot.md` (workstream WS-W).

## 10. Open questions

1. ~~`wiki/` vs `docs/wiki/` vs configurable `wiki_dir`~~ — **RESOLVED at acceptance:
   configurable `wiki_dir`, default `docs/wiki`.**
2. Auto-append autonomy: when (if ever) may the agent write zone-2 pages without a
   plan gate? Suggest: never in P1/P2; revisit with Decision 20d autonomy levels.
3. Does `wiki_read`/`wiki_upsert` warrant two MCP tools, or one `wiki` tool with an
   `action` param? (Tool-count pressure on the 7-verb surface, Decision 27.)
4. Backfill: distill the *entire* existing webcache or only on next access (lazy)?
5. How the wiki interacts with Claude Code auto-memory (`MEMORY.md`) — proposal:
   memory stays personal/behavioral, wiki holds project knowledge; a memory that turns
   out to be project knowledge should graduate to a wiki page.
