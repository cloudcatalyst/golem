/**
 * WS-E E2 — the P0 skill files `golem init` installs.
 *
 * Directory-namespaced per verification-notes §11:
 * `.claude/skills/golem/<name>/SKILL.md` surfaces as `/golem/<name>`.
 * Each skill delegates to the frozen MCP tool names (plan §2.5); the
 * `/mcp__golem__*` prompt twins come from the MCP server directly.
 */

const slider = `---
description: Show or set the Golem token-savings slider (0 passthrough … 3 aggressive)
invocationMode: user
---

The user wants to view or change Golem's savings slider.

Arguments: $ARGUMENTS

- If the arguments contain a level (0-3), call the \`level\` MCP tool
  with that level, then confirm the change and briefly say what the new level does.
  If the level is 0, warn that redaction is OFF at level 0 (full bypass).
- If no level was given, call \`stats\` and report the current slider level.
- If the Golem MCP tools are unavailable, tell the user the Golem MCP server is
  not connected and suggest running \`golem init\` and restarting Claude Code.
`;

const stats = `---
description: Show Golem token-savings statistics for this project
invocationMode: user
---

Call the \`stats\` MCP tool and present the results: current slider level,
tokens before/after, and per-stage savings. Keep it to a short table. If the
tool is unavailable, say the Golem MCP server is not connected and suggest
running \`golem init\` and restarting Claude Code.
`;

const expand = `---
description: Expand a Golem CCR reference back to its original content
invocationMode: user
---

The user wants to expand a compressed content reference (CCR).

Arguments: $ARGUMENTS

Extract the CCR reference id from the arguments (or from the marker in recent
context, e.g. \`hash=<sha256>\` / \`[golem:ccr ref=...]\`) and call the
\`expand\` MCP tool with it. Show the retrieved original content. If the
reference is unknown, report that and suggest \`golem stats\` to check the store.
`;

const bypass = `---
description: Send the next request(s) untouched — bypass Golem compression
invocationMode: user
---

The user wants to bypass Golem's compression pipeline.

Golem's proxy honors the \`x-golem-bypass\` header for pure passthrough, and
slider level 0 (passthrough) disables all transformation. Note: level 0 ALSO
disables redaction (secrets/PII reach the upstream raw), so prefer \`level 1\`
(redaction on, byte-faithful) unless a true full bypass is intended. If setting
level 0, warn the user redaction is off. Call the \`level\` MCP tool with the
chosen level, then remind them to run \`/golem/slider 1\` (or their previous
level) to re-enable savings when done.
`;

const wikiQuery = `---
description: Answer a question from the project's wiki first, vector search second
invocationMode: user
---

The user wants to know about: $ARGUMENTS

Follow the wiki-first knowledge ladder (spec Decision 28):

1. Call \`wiki_read\` with the topic as \`title_or_path\` (try the page title
   first, e.g. "Prompt Caching"). If that misses, check the wiki's
   \`WIKI.md\` index (via \`fetch\` or \`search\`) for a page whose title is
   close but not identical, and \`wiki_read\` that instead.
2. If no wiki page covers it, call \`search\` and use \`fetch\` on the best
   hit(s) — wiki pages rank above other results, so a hit there is
   equivalent to step 1.
3. Answer using what you found, citing the page(s) or source path(s) you
   used. If nothing turned up in either the wiki or the knowledge base, say
   so plainly rather than guessing — don't fall back to general knowledge
   silently.
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
4. Propose the note to the user (show the title, a slug for
   \`sources/<slug>.md\`, and the body) and wait for approval — wiki writes
   are plan-gated (spec Decision 29), never automatic.
5. Only after approval, call \`wiki_upsert\` with \`rel_path: "sources/<slug>.md"\`,
   \`type: "source"\`, \`sources: ["$ARGUMENTS"]\`, and the approved body.
`;

/** name -> SKILL.md content; installed under .claude/skills/golem/<name>/. */
export const P0_SKILLS: Readonly<Record<string, string>> = {
  slider,
  stats,
  expand,
  bypass,
  "wiki-query": wikiQuery,
  "wiki-ingest": wikiIngest,
};
