/**
 * WS-W W2 — frontmatter parse/serialize/wikilink extraction (no filesystem).
 */

import { describe, expect, it } from "vitest";
import {
  extractWikilinks,
  parseFrontmatter,
  serializeFrontmatter,
} from "../../../src/wiki/index.js";

const SAMPLE = [
  "---",
  "title: Prompt Caching",
  "type: concept",
  "tags: [cache, prompts]",
  "sources: [https://example.com, docs/wiki/WIKI.md]",
  "created: 2026-07-10",
  "updated: 2026-07-10",
  "---",
  "",
  "# Prompt Caching",
  "",
  "See [[Wiki-First Knowledge]] for context.",
].join("\n");

describe("parseFrontmatter", () => {
  it("parses required keys, bracketed lists, and the body", () => {
    const { frontmatter, body } = parseFrontmatter(SAMPLE);
    expect(frontmatter).toEqual({
      title: "Prompt Caching",
      type: "concept",
      tags: ["cache", "prompts"],
      sources: ["https://example.com", "docs/wiki/WIKI.md"],
      created: "2026-07-10",
      updated: "2026-07-10",
    });
    expect(body).toBe("# Prompt Caching\n\nSee [[Wiki-First Knowledge]] for context.");
  });

  it("parses empty bracketed lists", () => {
    const raw = SAMPLE.replace("tags: [cache, prompts]", "tags: []").replace(
      "sources: [https://example.com, docs/wiki/WIKI.md]",
      "sources: []",
    );
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.tags).toEqual([]);
    expect(frontmatter.sources).toEqual([]);
  });

  it("throws when the leading --- delimiter is missing", () => {
    expect(() => parseFrontmatter("title: X\n---\nbody")).toThrow(/leading/);
  });

  it("throws when the closing --- delimiter is missing", () => {
    expect(() => parseFrontmatter("---\ntitle: X\nbody")).toThrow(/closing/);
  });

  it("throws when a required key is missing", () => {
    const raw = SAMPLE.split("\n")
      .filter((line) => !line.startsWith("updated:"))
      .join("\n");
    expect(() => parseFrontmatter(raw)).toThrow(/updated/);
  });
});

describe("serializeFrontmatter", () => {
  it("round-trips through parseFrontmatter", () => {
    const { frontmatter } = parseFrontmatter(SAMPLE);
    const reparsed = parseFrontmatter(`${serializeFrontmatter(frontmatter)}\n\nbody`);
    expect(reparsed.frontmatter).toEqual(frontmatter);
  });
});

describe("extractWikilinks", () => {
  it("extracts plain, aliased, and section-anchored wikilinks", () => {
    const body =
      "[[Prompt Caching]] and [[Wiki-First Knowledge|the pattern]] and [[Other#Section]].";
    expect(extractWikilinks(body)).toEqual(["Prompt Caching", "Wiki-First Knowledge", "Other"]);
  });

  it("returns an empty array when there are no wikilinks", () => {
    expect(extractWikilinks("no links here")).toEqual([]);
  });

  it("keeps duplicates in order of appearance", () => {
    expect(extractWikilinks("[[A]] then [[B]] then [[A]] again")).toEqual(["A", "B", "A"]);
  });
});
