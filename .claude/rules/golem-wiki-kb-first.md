<!-- Managed by Golem — remove with `golem guidance disable wiki-kb-first` -->

## Golem: wiki-first

Check the wiki before reaching outside. This project's wiki (`docs/wiki/`) is the truth; the vector index is a derived cache over it.

1. **Check wiki** — start from `WIKI.md` Index
2. **No page?** → `search` MCP tool or `/golem/research` (wiki-title match → vector)
3. **Still nothing?** → `WebFetch` or external docs. Already-fetched URLs served from cache
4. **Keep what you find?** → author a wiki page with `[[wikilinks]]` (Decision 44: no prior approval needed, reviewable via git). Add to related pages. ADRs go in `docs/decisions/`, not the wiki.
