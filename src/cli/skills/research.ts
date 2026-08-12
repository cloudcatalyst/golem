/**
 * Looking something up, and keeping what was found.
 *
 * `research` is the wiki → KB → web ladder (spec Decision 28); `wiki-ingest` is
 * the capture half that turns a fetched page into a durable wiki note.
 */

const research = `---
description: Research a topic the wiki-first way — wiki, then local KB, then external web, then capture. Use this for ANY external/doc lookup or fact you need to verify.
invocationMode: user
---

The user wants to know about: $ARGUMENTS

This skill is the canonical path for looking anything up — a project fact, an
external doc, an API detail you'd otherwise search for on the web. Always climb
the ladder in order (spec Decision 28); each rung is cheaper/more trustworthy
than the next, and jumping to the network wastes tokens on something the KB
already has.

1. **Wiki.** Call \`wiki_read\` with the topic as \`title_or_path\` (try the page
   title first, e.g. "Prompt Caching"). If that misses, check the wiki's
   \`WIKI.md\` index (via \`fetch\` or \`search\`) for a close-but-not-identical
   title and \`wiki_read\` that instead.
2. **Local KB.** If no wiki page covers it, call \`search\` and \`fetch\` the best
   hit(s) — wiki pages rank above other results. The KB also indexes every
   previously-fetched web page (cached under \`.golem/webcache\`), so a doc you
   or a teammate already fetched is here, not on the network.
3. **External web — only after 1 and 2 miss.** Now, and only now, WebFetch the
   source. Re-run \`search\` before EACH new fetch (a related earlier fetch may
   already answer it). A previously-fetched URL is served from the cache
   automatically, so re-fetching is free and offline; the fetch is
   redacted + cached + indexed for next time.
4. **Answer**, citing the page(s)/source path(s)/URL(s) you used. If nothing
   turned up anywhere, say so plainly rather than guessing — never fall back to
   general knowledge silently.
5. **Capture what's worth keeping.** A fetched page is searchable but orphaned
   until it's a wiki page. If the finding is durable, propose a wiki
   source-note (run \`/golem/wiki-ingest <url>\`) with real \`[[wikilinks]]\`,
   citing the source. Author wiki pages freely (spec Decision 44) — no prior
   approval needed; every write is committed to git and reviewable.
`;

const wikiIngest = `---
description: Distill a URL into a new wiki source note (proposed, not auto-written)
invocationMode: user
---

The user wants to add this URL to the project's wiki: $ARGUMENTS

1. Fetch the URL (WebFetch's knowledge-base cache hook captures the raw
   content automatically — no separate ingest step needed for that).
2. Run \`golem wiki distill $ARGUMENTS\` via Bash. This checks for an
   existing local-model draft first and reuses it (Decision 29: prefer an
   existing draft over re-distilling); if none exists yet, it distills one
   now from the cache with the local model. Read the printed draft path with
   the Read tool — the draft is already wiki-shaped (frontmatter + body,
   \`type: source\`) at \`.golem/distill/<slug>.md\` (zone 1, local only, not
   in the wiki yet).
3. Review the draft: rewrite anything that isn't genuinely in your own
   words, quotes the page at length, or invents a candidate wikilink — the
   wiki stores distilled notes, not raw copies (see \`docs/wiki/WIKI.md\`'s
   write rules). If \`golem wiki distill\` isn't available (no local model
   configured), distill the note yourself instead.
4. Call \`wiki_upsert\` with \`rel_path: "sources/<slug>.md"\`, \`type: "source"\`,
   \`sources: ["$ARGUMENTS"]\`, and the reviewed body — author it directly (spec
   Decision 44); no prior approval needed, since the write is committed to git
   and reviewable. Surface any contradiction with an existing page rather than
   silently overwriting it.
`;

/** Skill name -> SKILL.md content, keyed as `/golem/<name>`. */
export const RESEARCH_SKILLS: Readonly<Record<string, string>> = {
  research,
  "wiki-ingest": wikiIngest,
};
