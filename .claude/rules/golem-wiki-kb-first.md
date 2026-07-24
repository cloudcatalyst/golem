<!-- Managed by Golem — remove with `golem guidance disable wiki-kb-first` -->

## Golem: wiki-first knowledge (spec Decision 28)

Apply this proactively — you do not need the user to ask. This project keeps a
durable, committed wiki (default `docs/wiki/` — see its `WIKI.md` for the exact
zones and write rules; the configured location may differ, check
`knowledge.wiki_dir` if unsure). Wiki pages are the source of truth; Golem's
local vector index — which also covers ingested source trees, this project's
other `.md` docs, and every page fetched with WebFetch — is just a derived,
rebuildable cache over them.

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
   can find it later. Author wiki pages freely — no prior approval needed
   (spec Decision 44); every write is committed to git, so it's reviewable
   and revertible. Redaction-before-storage still applies, and contradictions
   with an existing page are surfaced to the human, never auto-resolved.
   (Decisions — ADRs — live at `docs/decisions/`, outside the wiki, and keep
   their stricter human-driven rule.)
