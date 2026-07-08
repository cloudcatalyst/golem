/**
 * WS-C C2 — chunker units. Pure functions, no I/O.
 */

import { describe, expect, it } from "vitest";
import { WINDOW_LINES, WINDOW_OVERLAP } from "../../../src/knowledge/chunker.js";
import {
  chunkCode,
  chunkFile,
  chunkMarkdown,
  chunkText,
  isChunkableExtension,
  MAX_CHUNK_CHARS,
} from "../../../src/knowledge/index.js";

describe("chunkMarkdown", () => {
  it("splits by headings and captures heading metadata + line ranges", () => {
    const md = "# Title\n\nintro\n\n## Deploy\n\nrun migrations first\n\n## Test\n\nrun vitest\n";
    const chunks = chunkMarkdown(md);
    const headings = chunks.map((c) => c.metadata.heading);
    expect(headings).toContain("Deploy");
    expect(headings).toContain("Test");
    const deploy = chunks.find((c) => c.metadata.heading === "Deploy");
    expect(deploy?.text).toContain("run migrations first");
    expect(deploy?.startLine).toBeGreaterThan(0);
    expect(deploy?.endLine).toBeGreaterThanOrEqual(deploy?.startLine ?? 0);
    expect(chunks.every((c) => c.kind === "text")).toBe(true);
  });

  it("handles content before the first heading", () => {
    const chunks = chunkMarkdown("preamble line\n\n# Heading\n\nbody\n");
    expect(chunks[0]?.text).toContain("preamble line");
  });

  it("sub-splits an oversized section into line windows, preserving heading metadata and offsetting line numbers from the real section start", () => {
    // Preamble pushes the oversized section's heading off line 1, so the test
    // can catch line-offset bugs that a document starting at the section would hide.
    const preamble = ["# Title", "", "Some intro text before the big section.", ""];
    // 99 body lines (+ the heading line = 100) so the section spans > WINDOW_LINES
    // and its text exceeds MAX_CHUNK_CHARS, forcing the windowChunks fallback.
    const bodyLines = Array.from({ length: 99 }, () => "y".repeat(40));
    const md = [...preamble, "## Big Section", ...bodyLines].join("\n");
    expect(md.length).toBeGreaterThan(MAX_CHUNK_CHARS);

    const chunks = chunkMarkdown(md);
    const big = chunks.filter((c) => c.metadata.heading === "Big Section");
    expect(big.length).toBe(2);
    expect(big.every((c) => c.kind === "text")).toBe(true);
    expect(big.every((c) => c.metadata.heading === "Big Section")).toBe(true);

    // Heading is at 1-based document line 5 (4 preamble lines + the heading itself).
    const headingLine = preamble.length + 1;
    const totalLines = preamble.length + 1 + bodyLines.length;
    expect(big[0]?.startLine).toBe(headingLine);
    expect(big[0]?.endLine).toBe(headingLine + WINDOW_LINES - 1);
    expect(big[1]?.startLine).toBe(headingLine + (WINDOW_LINES - WINDOW_OVERLAP));
    expect(big[1]?.endLine).toBe(totalLines);
    // Windows overlap by exactly WINDOW_OVERLAP lines and together cover the section.
    expect((big[0]?.endLine ?? 0) - (big[1]?.startLine ?? 0) + 1).toBe(WINDOW_OVERLAP);
  });
});

describe("chunkCode", () => {
  it("splits at top-level declarations, one chunk per construct", () => {
    const code = [
      "import x from 'y';",
      "",
      "export function foo() {",
      "  return 1;",
      "}",
      "",
      "class Bar {",
      "  m() { return 2; }",
      "}",
    ].join("\n");
    const chunks = chunkCode(code);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.some((c) => c.text.includes("function foo"))).toBe(true);
    expect(chunks.some((c) => c.text.includes("class Bar"))).toBe(true);
    expect(chunks.every((c) => c.kind === "code")).toBe(true);
  });

  it("sub-splits an oversized top-level construct into line windows with correct offsets", () => {
    // A small leading construct pushes the oversized one off line 1, so the
    // test can catch line-offset bugs a document starting at line 1 would hide.
    const preamble = ["import x from 'y';", ""];
    // 99 indented body lines (+ decl line + closing brace = 101) so the construct
    // spans > WINDOW_LINES and its text exceeds MAX_CHUNK_CHARS.
    const bodyLines = Array.from({ length: 99 }, () => `  ${"z".repeat(40)};`);
    const code = [...preamble, "function bigFn() {", ...bodyLines, "}"].join("\n");
    expect(code.length).toBeGreaterThan(MAX_CHUNK_CHARS);

    const chunks = chunkCode(code);
    expect(chunks.length).toBe(3);
    const [importChunk, win1, win2] = chunks;
    expect(importChunk?.text).toContain("import x from 'y';");
    expect(win1?.kind).toBe("code");
    expect(win2?.kind).toBe("code");

    // The function decl is at 1-based document line 3 (2 preamble lines + itself).
    const declLine = preamble.length + 1;
    const totalLines = preamble.length + 1 + bodyLines.length + 1;
    expect(win1?.startLine).toBe(declLine);
    expect(win1?.endLine).toBe(declLine + WINDOW_LINES - 1);
    expect(win2?.startLine).toBe(declLine + (WINDOW_LINES - WINDOW_OVERLAP));
    expect(win2?.endLine).toBe(totalLines);
    // Windows overlap by exactly WINDOW_OVERLAP lines and together cover the construct.
    expect((win1?.endLine ?? 0) - (win2?.startLine ?? 0) + 1).toBe(WINDOW_OVERLAP);
  });
});

describe("chunkText", () => {
  it("produces non-empty windowed chunks", () => {
    const chunks = chunkText(Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"));
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.kind).toBe("text");
  });

  it("returns nothing for empty/whitespace input", () => {
    expect(chunkText("")).toStrictEqual([]);
    expect(chunkText("   \n\n  ")).toStrictEqual([]);
  });
});

describe("chunkFile dispatch + isChunkableExtension", () => {
  it("routes by extension", () => {
    expect(chunkFile("guide.md", "# H\n\nbody").every((c) => c.kind === "text")).toBe(true);
    expect(chunkFile("util.ts", "export function f(){}").every((c) => c.kind === "code")).toBe(
      true,
    );
    expect(chunkFile("notes.txt", "hello world").every((c) => c.kind === "text")).toBe(true);
  });

  it("recognizes chunkable extensions", () => {
    expect(isChunkableExtension(".md")).toBe(true);
    expect(isChunkableExtension(".ts")).toBe(true);
    expect(isChunkableExtension(".txt")).toBe(true);
    expect(isChunkableExtension(".png")).toBe(false);
    expect(isChunkableExtension(".exe")).toBe(false);
  });
});
