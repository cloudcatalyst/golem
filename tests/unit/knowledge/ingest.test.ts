/**
 * WS-C C2 — ingestion traversal + end-to-end KnowledgeBase.ingest→search, and
 * the frozen KnowledgeBase contract (now satisfiable: C1 read path + C2 write
 * path + a deterministic lexical embedder standing in for WS-D until C3).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type EmbedFn,
  GolemKnowledgeBase,
  InMemoryVectorDriver,
  openKnowledgeBase,
  planIngest,
  type VectorDriver,
} from "../../../src/knowledge/index.js";
import { describeKnowledgeBaseContract } from "../../contract/knowledge-contract.js";

/**
 * Deterministic lexical embedder: hashes tokens into a fixed-dim bag-of-words
 * vector. Cosine over these ranks by lexical overlap — enough for tests and the
 * contract; real semantic embeddings arrive with WS-D in C3.
 */
function lexicalEmbed(dim = 256): EmbedFn {
  return (texts) =>
    Promise.resolve(
      texts.map((t) => {
        const v = new Array<number>(dim).fill(0);
        for (const tok of t
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(Boolean)) {
          let h = 0;
          for (let i = 0; i < tok.length; i += 1) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
          v[h % dim] = (v[h % dim] ?? 0) + 1;
        }
        return v;
      }),
    );
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "golem-ingest-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("planIngest traversal", () => {
  it("walks a directory, chunks docs+code, skips vendored dirs and binaries", async () => {
    await writeFile(path.join(dir, "guide.md"), "# Deploy\n\nrun migrations before deploying\n");
    await writeFile(path.join(dir, "util.ts"), "export function add(a,b){return a+b;}\n");
    await mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(dir, "node_modules", "pkg", "index.js"), "module.exports={}");
    await writeFile(path.join(dir, "logo.png"), "not really an image");

    const plan = await planIngest(dir);
    const sources = new Set(plan.chunks.map((c) => c.sourcePath));
    expect(sources.has("guide.md")).toBe(true);
    expect(sources.has("util.ts")).toBe(true);
    // node_modules never walked; .png is not a chunkable type.
    expect([...sources].some((s) => s.includes("node_modules"))).toBe(false);
    expect(plan.filesSeen).toBe(2);
    expect(plan.chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("ingesting a single file uses its basename as the relative source path", async () => {
    const f = path.join(dir, "readme.md");
    await writeFile(f, "# Title\n\nhello\n");
    const plan = await planIngest(f);
    expect(plan.filesSeen).toBe(1);
    expect(plan.chunks[0]?.sourcePath).toBe("readme.md");
  });
});

describe("KnowledgeBase.ingest → search (end to end)", () => {
  it("indexes a corpus and ranks the on-topic chunk first", async () => {
    await writeFile(
      path.join(dir, "deploy.md"),
      "# Deployment\n\nAlways run migrations before deploying to production.\n",
    );
    await writeFile(path.join(dir, "testing.md"), "# Testing\n\nRun vitest to check the suite.\n");

    const kb = openKnowledgeBase({
      projectDir: dir,
      driver: new InMemoryVectorDriver(),
      embed: lexicalEmbed(),
    });
    const report = await kb.ingest(dir, "proj");
    expect(report.chunksIndexed).toBeGreaterThanOrEqual(2);
    expect(report.watching).toBe(false);

    // "migrations" appears only in deploy.md → it must rank first.
    const hits = await kb.search("migrations", "proj", 3, new Set(["knowledge"]));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.chunk.text).toContain("migrations");
    expect(hits[0]?.chunk.sourcePath).toBe("deploy.md");
  });

  it("watch:true starts a live watcher and reports watching:true", async () => {
    const kb = new GolemKnowledgeBase(new InMemoryVectorDriver(), { embed: lexicalEmbed() });
    try {
      const report = await kb.ingest(dir, "proj", true);
      expect(report.watching).toBe(true);
    } finally {
      kb.closeWatchers();
    }
  });

  it("watch:true is refused without a deletable driver", async () => {
    const undeletable: VectorDriver = {
      schemaVersion: 1,
      openCollection: async () => {},
      upsert: async () => {},
      search: async () => [],
      getChunk: async () => null,
      close: async () => {},
    };
    const kb = new GolemKnowledgeBase(undeletable, { embed: lexicalEmbed() });
    await expect(kb.ingest(dir, "proj", true)).rejects.toThrow(/file watching/);
  });
});

// The frozen contract now runs end-to-end (ingest + search + getChunk).
describeKnowledgeBaseContract("GolemKnowledgeBase", () =>
  openKnowledgeBase({
    projectDir: "/unused-for-inmemory",
    driver: new InMemoryVectorDriver(),
    embed: lexicalEmbed(),
  }),
);
