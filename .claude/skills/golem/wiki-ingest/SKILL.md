---
description: Distill a fetched URL into a wiki source note (plan-gated)
invocationMode: user
---

The user wants to turn a fetched page into a durable wiki source note.

Arguments: $ARGUMENTS (a URL)

1. Fetch the URL (WebFetch serves it from Golem's webcache automatically if it
   was fetched before — this is free and offline).
2. Check the wiki isn't already covering this: call `wiki_read` for a
   plausible title, and `search` for the topic. If a page already exists,
   prefer refining it over creating a near-duplicate.
3. Per `docs/wiki/WIKI.md`'s zone rules, do **not** paste raw fetched
   full-text into the wiki — write a short distilled note in your own words
   (what it says, why it's relevant here), citing the URL in `sources`. Pick
   `sources/<kebab-case-slug>.md` as the path and `type: source` unless an
   existing related concept page is the better fit.
4. Propose the page (path, title, tags, the distilled body, at least one
   wikilink to a related page) to the user and get approval — writes here are
   plan-gated (spec Decision 29). Do not call `wiki_upsert` before approval.
5. Once approved, call `wiki_upsert` with the agreed content.

If the Golem MCP tools are unavailable, tell the user the Golem MCP server is
not connected and suggest running `golem init` and restarting Claude Code.
