/**
 * R3.2 — text extraction for non-plain-text ingest formats. Runs BEFORE
 * chunking (`chunker.ts` stays pure-TS/zero-dependency and dispatches by
 * extension only); `.html` extraction is dependency-free, `.pdf` extraction
 * uses the optional `unpdf` package (bundled serverless PDF.js build, no
 * native/canvas dependency for text extraction — CLAUDE.md's "no heavyweight
 * native deps in the default install" hard rule).
 *
 * **`unpdf` is genuinely optional as of Decision 53 (Tier 2).** It was
 * *documented* as optional here and in the R3.2 debrief while actually being a
 * static import in `dependencies`, so it shipped to every `golem-run` user and
 * an install without it would have failed at module load. It is now loaded via
 * dynamic `import()` and cached, following the `tree-sitter-chunker.ts`
 * precedent, and `optionalDependencies` lets an install tolerate its absence.
 *
 * Absence degrades at the *feature* level rather than silently: extraction
 * throws `PdfExtractionUnavailableError`, which both call sites already handle
 * correctly without change — `planIngest`/`ingestPath` count the file in
 * `filesSkipped` and carry on, and `fetchRawPage` fails open so WebFetch runs
 * normally (Decision 42). Returning `""` instead would have ingested empty
 * documents that look successfully indexed, which is worse than skipping them.
 */

/** Cached `unpdf` module, or `null` when the package is not installed. */
type UnpdfModule = typeof import("unpdf");
let unpdfPromise: Promise<UnpdfModule | null> | null = null;

function loadUnpdf(): Promise<UnpdfModule | null> {
  unpdfPromise ??= import("unpdf").catch(() => null);
  return unpdfPromise;
}

/**
 * Thrown when `.pdf` text extraction is requested but `unpdf` is not installed.
 * Callers treat this as "skip this file" / "fall open", never as a crash.
 */
export class PdfExtractionUnavailableError extends Error {
  constructor() {
    super(
      "PDF text extraction needs the optional `unpdf` package — install it " +
        "(`npm install unpdf`) or see `golem ext status`. Skipping this file.",
    );
    this.name = "PdfExtractionUnavailableError";
  }
}

/**
 * Whether `.pdf` extraction is currently possible on this machine — i.e.
 * whether `unpdf` resolves. Used by the `golem ext` registry to report the
 * capability without attempting an extraction.
 */
export async function isPdfExtractionAvailable(): Promise<boolean> {
  return (await loadUnpdf()) !== null;
}

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

/**
 * Extract the merged text layer of a PDF (all pages joined with newlines).
 *
 * @throws PdfExtractionUnavailableError when `unpdf` is not installed.
 */
export async function extractPdfText(data: Uint8Array): Promise<string> {
  const unpdf = await loadUnpdf();
  if (unpdf === null) throw new PdfExtractionUnavailableError();
  // unpdf rejects a Node Buffer outright (it insists on a plain Uint8Array,
  // even though Buffer is one) — `readFile()` returns a Buffer, so normalize.
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const pdf = await unpdf.getDocumentProxy(bytes);
  const { text } = await unpdf.extractText(pdf, { mergePages: true });
  return text;
}
