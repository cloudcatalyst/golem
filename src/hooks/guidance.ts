/**
 * CLAUDE.md guidance-section writer (WS-B task B2): a short, marker-fenced
 * section telling Claude agents that oversized tool outputs are swapped for
 * CCR refs and how to expand them. Idempotent replace-between-markers, so
 * re-running init (or shipping new wording) updates the section in place and
 * never duplicates it. Wired into the E2 init flow by the integrator.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type InitAction, InitError } from "../cli/init.js";

export const GUIDANCE_BEGIN_MARKER = "<!-- golem:begin -->";
export const GUIDANCE_END_MARKER = "<!-- golem:end -->";

/**
 * The full fenced section written to the COMMITTED CLAUDE.md by `golem init`:
 * the project's BASE DEFAULTS (wiki/KB/coder-first), shared by the whole team.
 *
 * Optional, per-user opt-in features (e.g. prompt translation) are deliberately
 * NOT here — a personal choice shouldn't land in the shared file. A user who
 * enables such a feature adds its usage instruction to their own (gitignored)
 * CLAUDE.local.md; {@link promptTranslationGuidanceSnippet} produces a
 * paste-ready block for that.
 */
export function golemGuidanceSection(): string {
  const lines: string[] = [
    GUIDANCE_BEGIN_MARKER,
    "## Golem: how to work in this project (defaults — do these proactively)",
    "",
    "This project runs Golem. The practices below are the DEFAULT way to work",
    "here: apply them on your own initiative, every time they fit — you do not",
    "need the user to ask for them. They keep paid-model tokens for the judgment",
    "calls only you can make.",
    "",
    "## Golem: oversized tool outputs are swapped for CCR refs",
    "",
    "This project runs Golem (golem.run). A PostToolUse hook replaces oversized",
    "tool outputs (Bash, Read, Grep, Glob, WebFetch) with a compact digest:",
    "head/tail excerpts, byte/line counts, and a lossless reference marker like",
    "`Retrieve original: hash=<64-hex-id>`. The full original is stored locally",
    "under `.golem/ccr` — nothing is lost.",
    "",
    "When the excerpt is not enough, expand the reference:",
    "",
    "- call the `expand` MCP tool with `ref_id` set to the hex id, or",
    "- use `/golem/expand <id>` (or `/mcp__golem__expand <id>`).",
    "",
    "Expand only when needed — the full original re-enters context and costs",
    "the tokens the swap saved. Prefer re-running a narrower command (grep the",
    "file, limit the range) when you only need a small part.",
    "",
    "## Golem: wiki-first knowledge (spec Decision 28)",
    "",
    "This project keeps a durable, committed wiki (default `docs/wiki/` — see its",
    "`WIKI.md` for the exact zones and write rules; the configured location may",
    "differ, check `knowledge.wiki_dir` if unsure). Wiki pages are the source of",
    "truth; Golem's local vector index — which also covers ingested source trees,",
    "this project's other `.md` docs, and every page fetched with WebFetch — is",
    "just a derived, rebuildable cache over them.",
    "",
    "At the start of a session, skim the wiki's own `WIKI.md` Index once — it's",
    "cheap and tells you what's already known before you duplicate a search. Then",
    "follow this ladder before reaching outside the project:",
    "",
    "1. **Check the wiki first.** Look for an existing page on the topic (start",
    "   from the wiki's `WIKI.md` index).",
    "2. **No page? Search next.** Call the `search` MCP tool (or `/golem/research`)",
    "   with your query — it tries an exact wiki-title / one-hop-wikilink match",
    "   before vector search, and wiki pages rank above other hits; use `fetch`",
    "   for a hit's full text.",
    "3. **Still nothing? Then WebFetch or external docs.** A previously-fetched",
    "   URL is served from the cache automatically (the fetch is skipped and the",
    "   cached content is returned), so re-fetching the same page is free and",
    "   offline — the same goes for files brought in with the `ingest` tool and",
    "   ideas captured with `golem note`.",
    "4. **Learned something worth keeping?** A raw capture (a fetched page, an",
    "   ingested file, a captured note) is searchable but disconnected — it has",
    "   no place in the graph until it's a wiki page. Propose adding or updating",
    "   a page rather than letting the capture evaporate or sit as an orphaned",
    "   chunk; cite the raw source and add real `[[wikilinks]]` to every related",
    "   page it belongs with, so graph traversal (not just similarity search)",
    "   can find it later. Wiki writes are plan-gated (propose, get approval,",
    "   then write).",
    "",
    "## Golem: prefer the local model for coding drafts",
    "",
    "By default, before writing non-trivial code, draft it with the `coder` MCP",
    "tool first — a local model — then review and refine the result yourself",
    "rather than writing from scratch. Do this proactively; you don't need to be",
    "asked. It leaves the paid model's tokens for the judgment calls the local",
    "model can't make: review, integration, and anything genuinely hard. The",
    "local model is engaged only by explicit acts — `coder` (drafting), `golem",
    "task run` (servicing queued tasks), and (when enabled) `golem prompt",
    "translate`; the slider is a compression dial only and never auto-engages",
    "the model (Decision 31). Use `coder` at every level; skip it only when the",
    "task is too small for the round trip to pay off.",
    GUIDANCE_END_MARKER,
  ];
  return lines.join("\n");
}

/**
 * A paste-ready CLAUDE.local.md block instructing the agent to USE prompt
 * translation (R5.5). This is for a USER who has enabled the feature to add to
 * their own gitignored personal instructions — it is never written to the
 * committed CLAUDE.md. No golem markers, so it doesn't collide with the managed
 * section. `golem prompt guidance` prints it.
 */
export function promptTranslationGuidanceSnippet(): string {
  return [
    "## Golem: sharpen rough prompts with the local model",
    "",
    "When my instruction is terse or rough and a clearer prompt would help, run",
    '`golem prompt translate "<my note>"` and work from the clearer prompt it',
    "returns — a local model rewrites it, grounded in prompts I've accepted",
    "before. ALWAYS show the suggestion first and NEVER silently rewrite my",
    "intent; if I like it I can `golem prompt accept` to teach the style.",
    "",
  ].join("\n");
}

/**
 * Pure upsert: insert or replace the fenced section in `existing` file text
 * (null = file does not exist). Text outside the markers is preserved
 * byte-for-byte. Throws InitError on a dangling begin marker rather than
 * guessing where the user's section ends.
 */
export function upsertGuidance(existing: string | null): string {
  const section = golemGuidanceSection();
  if (existing === null || existing.trim() === "") {
    return `${section}\n`;
  }
  const begin = existing.indexOf(GUIDANCE_BEGIN_MARKER);
  if (begin === -1) {
    const sep = existing.endsWith("\n") ? "\n" : "\n\n";
    return `${existing}${sep}${section}\n`;
  }
  const endMarkerAt = existing.indexOf(GUIDANCE_END_MARKER, begin);
  if (endMarkerAt === -1) {
    throw new InitError(
      `found ${GUIDANCE_BEGIN_MARKER} without a matching ${GUIDANCE_END_MARKER} — ` +
        "fix the Golem section markers, then retry",
    );
  }
  const end = endMarkerAt + GUIDANCE_END_MARKER.length;
  return existing.slice(0, begin) + section + existing.slice(end);
}

export interface GuidanceWriteOptions {
  readonly projectDir: string;
  /** File to hold the section; default `<projectDir>/CLAUDE.md`. */
  readonly filePath?: string;
  /** Compute and report the action without writing anything. */
  readonly dryRun?: boolean;
}

/** Write (or refresh) the guidance section; reports an init-style action. */
export async function writeGuidanceSection(options: GuidanceWriteOptions): Promise<InitAction> {
  const file = options.filePath ?? path.join(options.projectDir, "CLAUDE.md");
  const relPath = path.relative(options.projectDir, file).split(path.sep).join("/");

  let existing: string | null;
  try {
    existing = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    existing = null;
  }

  const next = upsertGuidance(existing);
  if (existing === next) {
    return { kind: "skip", path: relPath, detail: "guidance section up to date" };
  }
  if (options.dryRun !== true) await writeFile(file, next, "utf8");
  return {
    kind: existing === null ? "create" : "modify",
    path: relPath,
    detail: "Golem guidance section (oversized tool outputs / expand)",
  };
}
