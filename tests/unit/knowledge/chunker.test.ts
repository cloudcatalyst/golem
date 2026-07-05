/**
 * WS-C C2 — chunker units. Pure functions, no I/O.
 */

import { describe, expect, it } from "vitest";
import {
  chunkCode,
  chunkFile,
  chunkMarkdown,
  chunkText,
  isChunkableExtension,
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
