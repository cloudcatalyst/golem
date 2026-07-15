---
description: Research a topic via the project wiki first, vector search second
invocationMode: user
---

The user wants to know about: $ARGUMENTS

Follow the wiki-first knowledge ladder (spec Decision 28):

1. Call `wiki_read` with the topic as `title_or_path` (try the page title
   first, e.g. "Prompt Caching"). If that misses, check the wiki's
   `WIKI.md` index (via `fetch` or `search`) for a page whose title is
   close but not identical, and `wiki_read` that instead.
2. If no wiki page covers it, call `search` and use `fetch` on the best
   hit(s) — wiki pages rank above other results, so a hit there is
   equivalent to step 1.
3. Answer using what you found, citing the page(s) or source path(s) you
   used. If nothing turned up in either the wiki or the knowledge base, say
   so plainly rather than guessing — don't fall back to general knowledge
   silently.
