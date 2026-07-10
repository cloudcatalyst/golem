/**
 * Frontmatter parse/serialize for wiki pages (WS-W W2). Hand-rolled rather
 * than pulling in a YAML dependency: the schema is small and fixed
 * (`docs/wiki/WIKI.md`), and the repo avoids heavyweight deps in the default
 * install.
 */

import type { WikiFrontmatter, WikiPageType } from "../interfaces/index.js";

const FRONTMATTER_DELIMITER = "---";
const REQUIRED_KEYS = ["title", "type", "tags", "sources", "created", "updated"] as const;

export interface ParsedFrontmatter {
  readonly frontmatter: WikiFrontmatter;
  readonly body: string;
}

function parseListValue(value: string): readonly string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error(`expected a bracketed list, got: ${value}`);
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((item) => item.trim());
}

/**
 * Parse `---`-delimited frontmatter + body from a raw wiki page file.
 * Delimiter/blank-line checks trim each line so CRLF pages (a checkout
 * without this repo's `eol=lf` attribute) parse the same as LF pages.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    throw new Error("wiki page is missing the leading --- frontmatter delimiter");
  }

  const closingIndex = lines.findIndex(
    (line, index) => index >= 1 && line.trim() === FRONTMATTER_DELIMITER,
  );
  if (closingIndex === -1) {
    throw new Error("wiki page is missing the closing --- frontmatter delimiter");
  }

  const values: Record<string, string | readonly string[]> = {};
  for (const line of lines.slice(1, closingIndex)) {
    if (line.trim() === "") continue;
    const colonAt = line.indexOf(":");
    if (colonAt === -1) throw new Error(`malformed frontmatter line (no ':'): ${line}`);
    const key = line.slice(0, colonAt).trim();
    const value = line.slice(colonAt + 1).trim();
    values[key] = key === "tags" || key === "sources" ? parseListValue(value) : value;
  }

  for (const key of REQUIRED_KEYS) {
    if (values[key] === undefined) throw new Error(`wiki page frontmatter is missing "${key}"`);
  }

  const frontmatter: WikiFrontmatter = {
    title: values.title as string,
    type: values.type as WikiPageType,
    tags: values.tags as readonly string[],
    sources: values.sources as readonly string[],
    created: values.created as string,
    updated: values.updated as string,
  };

  let bodyStart = closingIndex + 1;
  if (bodyStart < lines.length && lines[bodyStart]?.trim() === "") bodyStart += 1;
  const body = lines.slice(bodyStart).join("\n");

  return { frontmatter, body };
}

/** Serialize frontmatter back to the `---`-delimited block (no trailing newline). */
export function serializeFrontmatter(fm: WikiFrontmatter): string {
  return [
    FRONTMATTER_DELIMITER,
    `title: ${fm.title}`,
    `type: ${fm.type}`,
    `tags: [${fm.tags.join(", ")}]`,
    `sources: [${fm.sources.join(", ")}]`,
    `created: ${fm.created}`,
    `updated: ${fm.updated}`,
    FRONTMATTER_DELIMITER,
  ].join("\n");
}

const WIKILINK_PATTERN = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

/** Titles referenced by `[[Title]]` / `[[Title|Alias]]` / `[[Title#Section]]`, in order, duplicates kept. */
export function extractWikilinks(body: string): string[] {
  return [...body.matchAll(WIKILINK_PATTERN)].map((match) => match[1]?.trim() ?? "");
}
