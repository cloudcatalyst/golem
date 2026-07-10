---
description: Look up a topic in the project wiki before searching elsewhere
invocationMode: user
---

The user wants to look something up in the project wiki.

Arguments: $ARGUMENTS (a topic, title, or question)

1. Check `docs/wiki/WIKI.md`'s index for a page that matches, then call
   `wiki_read` with the best title or path guess.
2. If that misses, call `search` (the vector index also covers wiki pages,
   ranked above other hits) and use `fetch` on a promising hit's chunk id.
3. If a hit's `source_path` points into the wiki, call `wiki_read` on the
   real page instead of relying on the chunk excerpt — you get the full page
   plus its frontmatter and wikilinks.
4. Report what the wiki says, citing the page title/path. If nothing in the
   wiki covers it, say so explicitly rather than guessing — this is a read
   skill; do not call `wiki_upsert` here (see `/golem/wiki-ingest` for adding
   pages).

If the Golem MCP tools are unavailable, tell the user the Golem MCP server is
not connected and suggest running `golem init` and restarting Claude Code.
