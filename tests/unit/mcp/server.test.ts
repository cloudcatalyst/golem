/**
 * WS-W W1c — `boostWikiHits`: rank wiki-dir hits above equal-scoring non-wiki
 * hits (spec Decision 28), inert when `wikiDir` is unset or nothing matches.
 */

import { describe, expect, it } from "vitest";
import type { Hit } from "../../../src/interfaces/index.js";
import { boostWikiHits } from "../../../src/mcp/server.js";

function hit(chunkId: string, sourcePath: string | undefined, score: number): Hit {
  return {
    chunk: {
      chunkId,
      projectId: "p",
      text: "",
      ...(sourcePath !== undefined ? { sourcePath } : {}),
      metadata: {},
    },
    score,
    scope: "knowledge",
  };
}

describe("boostWikiHits", () => {
  it("is a no-op when wikiDir is undefined", () => {
    const hits = [hit("a", "docs/wiki/x.md", 0.5), hit("b", "src/y.ts", 0.9)];
    expect(boostWikiHits(hits, undefined)).toEqual(hits);
  });

  it("promotes an equal-scoring wiki hit above a non-wiki hit", () => {
    const wiki = hit("a", "docs/wiki/x.md", 0.8);
    const other = hit("b", "src/y.ts", 0.8);
    const result = boostWikiHits([other, wiki], "docs/wiki");
    expect(result.map((h) => h.chunk.chunkId)).toEqual(["a", "b"]);
  });

  it("does not promote a lower-scoring wiki hit past a much stronger non-wiki hit", () => {
    const wiki = hit("a", "docs/wiki/x.md", 0.1);
    const other = hit("b", "src/y.ts", 0.9);
    const result = boostWikiHits([other, wiki], "docs/wiki");
    expect(result.map((h) => h.chunk.chunkId)).toEqual(["b", "a"]);
  });

  it("is separator-safe: a sibling directory sharing the prefix is not boosted", () => {
    const wiki = hit("a", "docs/wiki/x.md", 0.5);
    const sibling = hit("b", "docs/wiki-other/y.md", 0.5);
    const result = boostWikiHits([sibling, wiki], "docs/wiki");
    // Both score 0.5; only "a" is boosted, so it must sort first.
    expect(result.map((h) => h.chunk.chunkId)).toEqual(["a", "b"]);
  });

  it("treats the wiki root file itself (sourcePath === wikiDir) as under the wiki", () => {
    const root = hit("a", "docs/wiki", 0.5);
    const other = hit("b", "src/y.ts", 0.5);
    const result = boostWikiHits([other, root], "docs/wiki");
    expect(result.map((h) => h.chunk.chunkId)).toEqual(["a", "b"]);
  });

  it("leaves hits with no sourcePath un-boosted and order-stable among ties", () => {
    const noSource = hit("a", undefined, 0.5);
    const other = hit("b", "src/y.ts", 0.5);
    const result = boostWikiHits([noSource, other], "docs/wiki");
    expect(result.map((h) => h.chunk.chunkId)).toEqual(["a", "b"]);
  });
});
