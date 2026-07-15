---
description: Distill a URL into a new wiki source note (proposed, not auto-written)
invocationMode: user
---

The user wants to add this URL to the project's wiki: $ARGUMENTS

1. Fetch the URL (WebFetch's knowledge-base cache hook captures the raw
   content automatically — no separate ingest step needed for that).
2. Run `golem wiki distill $ARGUMENTS` via Bash. This checks for an
   existing local-model draft first and reuses it (Decision 29: prefer an
   existing draft over re-distilling); if none exists yet, it distills one
   now from the cache with the local model. Read the printed draft path with
   the Read tool — the draft is already wiki-shaped (frontmatter + body,
   `type: source`) at `.golem/distill/<slug>.md` (zone 1, local only, not
   in the wiki yet).
3. Review the draft: rewrite anything that isn't genuinely in your own
   words, quotes the page at length, or invents a candidate wikilink — the
   wiki stores distilled notes, not raw copies (see `docs/wiki/WIKI.md`'s
   write rules). If `golem wiki distill` isn't available (no local model
   configured), distill the note yourself instead.
4. Propose the note to the user (show the title, a slug for
   `sources/<slug>.md`, and the body) and wait for approval — wiki writes
   are plan-gated (spec Decision 29), never automatic.
5. Only after approval, call `wiki_upsert` with `rel_path: "sources/<slug>.md"`,
   `type: "source"`, `sources: ["$ARGUMENTS"]`, and the approved body.
