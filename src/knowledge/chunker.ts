/**
 * WS-C C2 — chunkers. Pure TS, zero dependencies.
 *
 * - Markdown: heading-aware. A chunk spans one heading and its body up to the
 *   next heading of the same or shallower level; oversized sections are split
 *   on blank-line (paragraph) boundaries so no chunk blows past the size cap.
 * - Code: dependency-free heuristic. Splits at top-level declaration boundaries
 *   (a decl keyword at column 0); huge constructs fall back to line windows.
 *   Semantic (tree-sitter / Headroom code-graph) chunking is a documented
 *   follow-up — verification-notes §27.
 * - Text/other: fixed line windows with overlap.
 *
 * Every chunk carries 1-based [startLine, endLine] and a `kind` ("text"|"code")
 * so ingestion can embed with the right model.
 */

import path from "node:path";

/** A chunk before it is assigned a chunkId/projectId/sourcePath. */
export interface RawChunk {
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly kind: "text" | "code";
  readonly metadata: Readonly<Record<string, string>>;
}

/** Soft cap on chunk size (characters) before a section is sub-split. */
export const MAX_CHUNK_CHARS = 2_000;
/** Line-window size + overlap for text/oversized-code fallback. */
export const WINDOW_LINES = 60;
export const WINDOW_OVERLAP = 8;

const MARKDOWN_EXT = new Set([".md", ".markdown", ".mdx"]);
const CODE_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".sh",
]);

function trimTrailingBlank(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end -= 1;
  return lines.slice(0, end);
}

/** Fixed line windows with overlap; used for plain text and oversized code. */
export function windowChunks(
  lines: readonly string[],
  baseLine: number,
  kind: "text" | "code",
  metadata: Readonly<Record<string, string>>,
): RawChunk[] {
  const out: RawChunk[] = [];
  const step = Math.max(1, WINDOW_LINES - WINDOW_OVERLAP);
  for (let start = 0; start < lines.length; start += step) {
    const slice = trimTrailingBlank(lines.slice(start, start + WINDOW_LINES));
    if (slice.length === 0) continue;
    const text = slice.join("\n");
    if (text.trim() === "") continue;
    out.push({
      text,
      startLine: baseLine + start,
      endLine: baseLine + start + slice.length - 1,
      kind,
      metadata,
    });
    if (start + WINDOW_LINES >= lines.length) break;
  }
  return out;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** Heading-aware markdown chunking. */
export function chunkMarkdown(content: string): RawChunk[] {
  const lines = content.split(/\r?\n/);
  const sections: { start: number; end: number; heading: string; level: number }[] = [];
  let cur: { start: number; heading: string; level: number } | null = {
    start: 0,
    heading: "",
    level: 0,
  };
  for (let i = 0; i < lines.length; i += 1) {
    const m = HEADING_RE.exec(lines[i] ?? "");
    if (m) {
      if (cur) sections.push({ ...cur, end: i - 1 });
      cur = { start: i, heading: (m[2] ?? "").trim(), level: (m[1] ?? "#").length };
    }
  }
  if (cur) sections.push({ ...cur, end: lines.length - 1 });

  const out: RawChunk[] = [];
  for (const s of sections) {
    const body = trimTrailingBlank(lines.slice(s.start, s.end + 1));
    if (body.length === 0) continue;
    const text = body.join("\n");
    if (text.trim() === "") continue;
    const metadata = s.heading === "" ? {} : { heading: s.heading };
    if (text.length <= MAX_CHUNK_CHARS) {
      out.push({
        text,
        startLine: s.start + 1,
        endLine: s.start + body.length,
        kind: "text",
        metadata,
      });
    } else {
      // Oversized section: sub-split on line windows, keep the heading metadata.
      for (const w of windowChunks(body, s.start + 1, "text", metadata)) out.push(w);
    }
  }
  return out;
}

const TOP_LEVEL_DECL_RE =
  /^(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum|const|let|var|struct|impl|fn|def|public|private|protected|func)\b/;

/** Dependency-free heuristic code chunking: one chunk per top-level construct. */
export function chunkCode(content: string): RawChunk[] {
  const lines = content.split(/\r?\n/);
  // Boundaries: line 0, and any top-level declaration (no leading whitespace).
  const boundaries: number[] = [0];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.length > 0 && !/^\s/.test(line) && TOP_LEVEL_DECL_RE.test(line)) {
      boundaries.push(i);
    }
  }
  boundaries.push(lines.length);

  const out: RawChunk[] = [];
  for (let b = 0; b < boundaries.length - 1; b += 1) {
    const start = boundaries[b] ?? 0;
    const end = boundaries[b + 1] ?? lines.length;
    const slice = trimTrailingBlank(lines.slice(start, end));
    if (slice.length === 0) continue;
    const text = slice.join("\n");
    if (text.trim() === "") continue;
    if (text.length <= MAX_CHUNK_CHARS) {
      out.push({
        text,
        startLine: start + 1,
        endLine: start + slice.length,
        kind: "code",
        metadata: {},
      });
    } else {
      for (const w of windowChunks(slice, start + 1, "code", {})) out.push(w);
    }
  }
  return out;
}

/** Plain-text chunking: line windows with overlap. */
export function chunkText(content: string): RawChunk[] {
  return windowChunks(content.split(/\r?\n/), 1, "text", {});
}

/** Pick a chunker by file extension and chunk the content. */
export function chunkFile(filePath: string, content: string): RawChunk[] {
  const ext = path.extname(filePath).toLowerCase();
  if (MARKDOWN_EXT.has(ext)) return chunkMarkdown(content);
  if (CODE_EXT.has(ext)) return chunkCode(content);
  return chunkText(content);
}

/** Whether a file extension is one the chunkers handle (used by traversal). */
export function isChunkableExtension(ext: string): boolean {
  const e = ext.toLowerCase();
  return (
    MARKDOWN_EXT.has(e) ||
    CODE_EXT.has(e) ||
    e === ".txt" ||
    e === ".rst" ||
    e === ".html" ||
    e === ".pdf"
  );
}
