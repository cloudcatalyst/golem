/**
 * R3.2 — text extraction for non-plain-text ingest formats. Runs BEFORE
 * chunking (`chunker.ts` stays pure-TS/zero-dependency and dispatches by
 * extension only); `.html` extraction is dependency-free, `.pdf` extraction
 * uses the optional `unpdf` package (bundled serverless PDF.js build, no
 * native/canvas dependency for text extraction — CLAUDE.md's "no heavyweight
 * native deps in the default install" hard rule).
 */

import { extractText, getDocumentProxy } from "unpdf";

const BLOCK_TAGS = "p|div|br|li|h[1-6]|tr|table|blockquote|section|article|header|footer|ul|ol";
const BLOCK_OPEN_RE = new RegExp(`<(?:${BLOCK_TAGS})(?:\\s[^>]*)?>`, "gi");
const BLOCK_CLOSE_RE = new RegExp(`</(?:${BLOCK_TAGS})>`, "gi");

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === "#") {
      const codePoint =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Strip an HTML document down to its visible text: drops `<script>`/`<style>`
 * content and comments entirely, breaks lines at block-element boundaries so
 * paragraphs/headings/list items don't run together, decodes entities, and
 * collapses excess blank lines. Not a full parser — good enough for feeding
 * a chunker, not for round-tripping markup.
 */
export function extractHtmlText(html: string): string {
  const withoutNoise = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  const withLineBreaks = withoutNoise
    .replace(BLOCK_OPEN_RE, "\n")
    .replace(BLOCK_CLOSE_RE, "\n")
    .replace(/<[^>]+>/g, "");

  const decoded = decodeEntities(withLineBreaks);

  const lines = decoded.split(/\r?\n/).map((line) => line.trim());
  const collapsed: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line === "") {
      blankRun += 1;
      if (blankRun > 2) continue;
    } else {
      blankRun = 0;
    }
    collapsed.push(line);
  }
  return collapsed.join("\n").trim();
}

/** Extract the merged text layer of a PDF (all pages joined with newlines). */
export async function extractPdfText(data: Uint8Array): Promise<string> {
  // unpdf rejects a Node Buffer outright (it insists on a plain Uint8Array,
  // even though Buffer is one) — `readFile()` returns a Buffer, so normalize.
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}
