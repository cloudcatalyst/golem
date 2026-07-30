/**
 * R3.2 — HTML/PDF text extraction, run BEFORE chunking so `.html`/`.pdf`
 * ingest no longer routes raw markup/binary through the plain-text chunker.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractHtmlText,
  extractPdfText,
  isPdfExtractionAvailable,
  PdfExtractionUnavailableError,
} from "../../../src/knowledge/extractors.js";
import { rmTemp } from "../../helpers/tmp.js";

/** A hand-built minimal single-page PDF with a "Hello World" text layer. */
function minimalPdf(text: string): Uint8Array {
  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length ${text.length + 20} >>
stream
BT /F1 24 Tf 100 700 Td (${text}) Tj ET
endstream
endobj
trailer
<< /Size 6 /Root 1 0 R >>
%%EOF`;
  return new TextEncoder().encode(pdf);
}

describe("extractHtmlText", () => {
  it("strips tags but keeps visible text", () => {
    const html = "<html><body><h1>Title</h1><p>Hello <b>world</b>.</p></body></html>";
    const text = extractHtmlText(html);
    expect(text).toContain("Title");
    expect(text).toContain("Hello");
    expect(text).toContain("world");
    expect(text).not.toContain("<");
    expect(text).not.toContain(">");
  });

  it("drops script and style content entirely, not just the tags", () => {
    const html =
      "<html><head><style>body{color:red}</style></head>" +
      "<body><script>alert('should not appear');</script><p>Visible text</p></body></html>";
    const text = extractHtmlText(html);
    expect(text).toContain("Visible text");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("should not appear");
  });

  it("drops HTML comments", () => {
    const html = "<p>Before</p><!-- a secret comment --><p>After</p>";
    const text = extractHtmlText(html);
    expect(text).not.toContain("secret comment");
    expect(text).toContain("Before");
    expect(text).toContain("After");
  });

  it("separates block-level elements onto their own lines", () => {
    const html = "<ul><li>First</li><li>Second</li></ul><p>Paragraph</p>";
    const text = extractHtmlText(html);
    const lines = text.split("\n").filter((l) => l !== "");
    expect(lines).toEqual(["First", "Second", "Paragraph"]);
  });

  it("decodes named and numeric HTML entities", () => {
    const html = "<p>Tom &amp; Jerry &mdash;? &#39;quoted&#39; &#x41;</p>";
    // &mdash; is intentionally NOT in the small named table — left as-is.
    const text = extractHtmlText(html);
    expect(text).toContain("Tom & Jerry");
    expect(text).toContain("'quoted'");
    expect(text).toContain("A");
  });

  it("collapses runs of more than two blank lines down to at most two", () => {
    const html = "<p>One</p>\n\n\n\n\n<p>Two</p>";
    const text = extractHtmlText(html);
    const lines = text.split("\n");
    const oneIdx = lines.indexOf("One");
    const twoIdx = lines.indexOf("Two");
    const blankLinesBetween = lines.slice(oneIdx + 1, twoIdx).filter((l) => l === "").length;
    expect(blankLinesBetween).toBe(2);
  });
});

describe("extractPdfText", () => {
  it("extracts the text layer of a real PDF document", async () => {
    const text = await extractPdfText(minimalPdf("Hello World"));
    expect(text).toContain("Hello World");
  });
});

/**
 * Decision 53 — `unpdf` is a Tier 2 managed tool, so it must be loaded lazily
 * and its absence must be a *reported* skip, not a module-load crash. It is
 * installed in this checkout (optionalDependencies), so what is asserted here is
 * the contract's shape; the absent branch is covered by the `golem ext` registry
 * reporting `not-installed` and by `planIngest`'s existing per-file catch.
 */
describe("optional unpdf (Decision 53)", () => {
  it("reports PDF extraction as available when unpdf is installed", async () => {
    await expect(isPdfExtractionAvailable()).resolves.toBe(true);
  });

  it("names the install remedy in the unavailable error", () => {
    const err = new PdfExtractionUnavailableError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PdfExtractionUnavailableError");
    expect(err.message).toContain("unpdf");
    expect(err.message).toContain("golem ext status");
  });

  it("is caught by planIngest's per-file guard rather than aborting the run", async () => {
    // The contract that makes absence a no-op: an extraction failure for one
    // file must leave the rest of the ingest intact. Proven here with a corrupt
    // PDF, which takes the same path an absent unpdf would.
    const { planIngest } = await import("../../../src/knowledge/ingest.js");
    const dir = await mkdtemp(path.join(tmpdir(), "golem-pdf-skip-"));
    try {
      await writeFile(path.join(dir, "broken.pdf"), "not a pdf at all");
      await writeFile(path.join(dir, "fine.md"), "# Real content\n\nSome prose to chunk.\n");
      const plan = await planIngest(dir);
      expect(plan.filesSkipped).toBeGreaterThanOrEqual(1);
      expect(plan.chunks.some((c) => c.sourcePath === "fine.md")).toBe(true);
    } finally {
      await rm(dir, rmTemp);
    }
  });
});
