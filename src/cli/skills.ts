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

const develop = `---
description: Orchestrate building a feature or fix end-to-end — research the wiki/KB, draft code+tests with the coder tool, verify, iterate
invocationMode: auto
---

The user (or Claude's own judgment) has identified development work to do: $ARGUMENTS

1. **Research first.** Run the \`/golem/research\` skill (or its steps
   directly: \`wiki_read\` the likely page, else \`search\` + \`fetch\`) for the
   feature area so you understand existing patterns, prior decisions, and
   frozen interfaces before writing anything.
2. **Draft with \`coder\` first — but only when it pays.** Per this project's
   coder-first convention, call the \`coder\` MCP tool to draft non-trivial
   implementation and tests. The tool now **grounds** drafts in the local
   knowledge base automatically (relevant project/wiki hits are injected), so
   you usually don't need to hand-feed context — add \`context\` only for
   specifics search won't surface. For a genuinely non-trivial draft, pass
   \`refine: true\` to run a local judge→revise pass (it roughly doubles local
   latency, so it earns its keep only on real logic, not boilerplate). **Skip
   \`coder\` entirely** for trivial edits (a rename, a one-line fix, a tiny
   test tweak) — the round trip costs more than it saves.
3. **Review and finalize.** Treat the draft as a starting point, not a final
   answer — rewrite anything that doesn't fit this codebase's conventions
   (frozen interfaces, TS strict, zod at boundaries, no unneeded abstraction).
   Check the draft's \`grounding\`/\`refinement\` fields to see what it was based
   on and whether the local judge changed anything.
4. **Verify.** Run the project's check command (e.g. \`npm run check\` — lint
   + typecheck + test) via Bash. On failure, fix and re-run; use \`coder\`
   again for non-trivial fixes.
5. **Report** what changed and which files were touched. Don't commit unless
   asked.

If \`coder\`/\`research\` are unavailable, say the Golem MCP server isn't
connected and suggest \`golem init\` and restarting Claude Code.
`;

const plan = `---
description: Turn captured notes, open questions, and distill drafts into concrete tasks — together, plan-gated
invocationMode: user
---

The user wants a collaborative planning session. Optional focus topic: $ARGUMENTS

This closes the second-brain loop into tasks (spec Decision 36). Your job is to
surface candidate work from what Golem has already captured, discuss it with the
user, and — only with approval — record agreed tasks in the plan docs. You are a
co-pilot here: the human decides what becomes a task.

1. **Gather inputs (read-only — read, never write in this step).** If a focus
   topic was given, prioritize inputs matching it, but still skim the rest.
   - Recent \`golem note\` captures: run \`golem note list\` via Bash (add
     \`-n <count>\` for more than the default 20, or \`--json\` for exact
     timestamps to cite).
   - Open questions: read the pages under \`docs/wiki/questions/\` (list the dir,
     Read each; or \`wiki_read\` a page by title).
   - Pending distill drafts: list \`.golem/distill/\` and Read the drafts (these
     are captured ideas/sources already shaped into draft wiki pages, not yet
     promoted).
   - The ideas inbox: Read \`docs/plan/BACKLOG.md\`.
   - Current plan: Read \`docs/plan/ROADMAP.md\` (and the active batch brief it
     points to) so you don't propose something already scheduled or done.
2. **Surface candidates, grouped by source.** For each, give a one-line
   statement and cite exactly where it came from (a note timestamp, a
   \`questions/<slug>.md\` page, a \`distill:<slug>\` draft, or this conversation).
   Note anything already covered by an existing ROADMAP/BACKLOG entry instead of
   re-proposing it.
3. **Discuss with the user.** Ask which candidates are worth turning into tasks,
   what's out of scope, and what's missing. Let the user drive prioritization.
4. **Propose concrete task entries** for the agreed items:
   - New rows for \`docs/plan/BACKLOG.md\` (Date / Idea / Source / Status — see
     that file's own "How this file works" for the exact format), or
   - A promotion into \`docs/plan/ROADMAP.md\` / the active batch brief for items
     the user wants scheduled now (then set the BACKLOG row's Status to
     \`promoted\` with the task ID).
5. **Plan-gate every write.** Show the exact edit (file + the lines to
   add/change) and wait for explicit approval before touching any plan file.
   Never edit \`BACKLOG.md\`, \`ROADMAP.md\`, or a batch brief unprompted. Append
   rows; don't rewrite or delete another entry's wording.
6. **The planning contract** (mirrors the \`/golem/research\` query contract):
   cite a source for every proposed task, clearly flag what is your inference
   versus what the user actually stated, and admit gaps rather than inventing
   work to fill the page.

If the Golem MCP tools or CLI are unavailable, say the Golem MCP server isn't
connected and suggest \`golem init\` and restarting Claude Code.
`;

/** name -> SKILL.md content; installed under .claude/skills/golem/<name>/. */
export const P0_SKILLS: Readonly<Record<string, string>> = {
  slider,
  stats,
  expand,
  bypass,
  research,
  "wiki-ingest": wikiIngest,
  develop,
  plan,
};
