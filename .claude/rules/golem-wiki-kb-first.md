<!-- Managed by Golem — remove with `golem guidance disable wiki-kb-first` -->

## Golem: wiki-first (spec Decision 28)

Apply proactively; no need to be asked. The committed wiki (`docs/wiki/` by
default — `knowledge.wiki_dir` if it was moved) is the truth. The vector index —
which also covers ingested trees, other `.md` docs and every WebFetch — is a
derived cache over it. Skim `WIKI.md`'s Index once per session before searching.

1. **Check the wiki first** — start from `WIKI.md`
2. **No page?** → `search` MCP tool or `/golem-research` (exact wiki-title /
   one-hop-wikilink match before vector; `fetch` for a hit's full text)
3. **Still nothing?** Then WebFetch or external docs. An already-fetched URL is
   served from cache — free and offline, as are `ingest` files and `golem note`
4. **Keep what you find?** A raw capture is searchable but disconnected. Author
   a wiki page with real `[[wikilinks]]` to related pages, citing the source, so
   graph traversal finds it later. No prior approval needed (Decision 44) — git
   makes every write reviewable. ADRs go in `docs/decisions/`, not the wiki.

Redaction-before-storage still applies, and contradictions are surfaced to the
human, never auto-resolved.
