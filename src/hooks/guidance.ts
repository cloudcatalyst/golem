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

/** The full fenced section, markers included (no trailing newline). */
export function golemGuidanceSection(): string {
  return [
    GUIDANCE_BEGIN_MARKER,
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
    "## Golem: knowledge base — search before you fetch",
    "",
    "This project's local docs (`.md` files) and every page you fetch with",
    "WebFetch are kept in Golem's local vector knowledge base. **Before using",
    "WebFetch or reaching for external docs, search the knowledge base first** —",
    "call the `search` MCP tool (or `/golem/search`) with your query; use",
    "`fetch` for a hit's full text. A previously-fetched URL is served",
    "from the cache automatically (the fetch is skipped and the cached content is",
    "returned), so re-fetching the same page is free and offline.",
    GUIDANCE_END_MARKER,
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
