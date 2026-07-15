/**
 * WS-C C1 — vector driver + KnowledgeBase read path. In-memory driver + a fake
 * embedder; no native store or real embeddings required.
 */

import { describe, expect, it } from "vitest";
import type { MemoryFact, MemorySearchProvider } from "../../../src/compression/index.js";
import type { Chunk } from "../../../src/interfaces/knowledge.js";
import { UnknownChunkError } from "../../../src/interfaces/knowledge.js";
import {
  cosineSimilarity,
  type EmbedFn,
  InMemoryVectorDriver,
  isMemoryChunkId,
  KNOWLEDGE_SCHEMA_VERSION,
  NotImplementedYetError,
  openKnowledgeBase,
  type StoredChunk,
} from "../../../src/knowledge/index.js";

function chunk(id: string, projectId: string, text: string): Chunk {
  return { chunkId: id, projectId, text, metadata: {} };
}

function rec(id: string, projectId: string, text: string, vector: number[]): StoredChunk {
  return { chunk: chunk(id, projectId, text), vector };
}

describe("cosineSimilarity", () => {
  it("is 1 for identical direction, 0 for orthogonal, 0 on dim mismatch", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("InMemoryVectorDriver", () => {
  it("reports the schema version", () => {
    expect(new InMemoryVectorDriver().schemaVersion).toBe(KNOWLEDGE_SCHEMA_VERSION);
  });

  it("returns nearest neighbors by cosine, score descending", async () => {
    const d = new InMemoryVectorDriver();
    await d.upsert("p", [
      rec("a", "p", "alpha", [1, 0, 0]),
      rec("b", "p", "beta", [0.9, 0.1, 0]),
      rec("c", "p", "gamma", [0, 1, 0]),
    ]);
    const hits = await d.search("p", [1, 0, 0], 2);
    expect(hits.map((h) => h.chunkId)).toStrictEqual(["a", "b"]);
    expect(hits[0]?.score).toBeGreaterThanOrEqual(hits[1]?.score ?? 0);
  });

  it("isolates projects — a query in one project never sees another's vectors", async () => {
    const d = new InMemoryVectorDriver();
    await d.upsert("p1", [rec("x", "p1", "x", [1, 0])]);
    await d.upsert("p2", [rec("y", "p2", "y", [1, 0])]);
    const hits = await d.search("p1", [1, 0], 10);
    expect(hits.map((h) => h.chunkId)).toStrictEqual(["x"]);
  });

  it("getChunk returns the stored chunk globally, null when absent", async () => {
    const d = new InMemoryVectorDriver();
    await d.upsert("p", [rec("a", "p", "hello", [1, 0])]);
    expect((await d.getChunk("a"))?.text).toBe("hello");
    expect(await d.getChunk("missing")).toBeNull();
  });

  it("upsert replaces a record with the same chunkId", async () => {
    const d = new InMemoryVectorDriver();
    await d.upsert("p", [rec("a", "p", "v1", [1, 0])]);
    await d.upsert("p", [rec("a", "p", "v2", [0, 1])]);
    expect((await d.getChunk("a"))?.text).toBe("v2");
    expect(await d.search("p", [1, 0], 5)).toHaveLength(1);
  });
});

describe("GolemKnowledgeBase read path", () => {
  // Fake embedder: map a couple of words to fixed vectors so search is deterministic.
  const embed: EmbedFn = (texts) =>
    Promise.resolve(
      texts.map((t) =>
        t.includes("deploy") ? [1, 0, 0] : t.includes("add") ? [0, 1, 0] : [0, 0, 1],
      ),
    );

  it("search embeds the query, ranks driver hits, tags scope=knowledge", async () => {
    const driver = new InMemoryVectorDriver();
    await driver.upsert("proj", [
      rec("deploy-doc", "proj", "deploy guide", [1, 0, 0]),
      rec("add-fn", "proj", "add function", [0, 1, 0]),
    ]);
    const kb = openKnowledgeBase({ projectDir: "/tmp/x", driver, embed });
    const hits = await kb.search("how do I deploy?", "proj", 2, new Set(["knowledge"]));
    expect(hits[0]?.chunk.chunkId).toBe("deploy-doc");
    expect(hits.every((h) => h.scope === "knowledge")).toBe(true);
  });

  it("getChunk round-trips and rejects unknown ids with UnknownChunkError", async () => {
    const driver = new InMemoryVectorDriver();
    await driver.upsert("proj", [rec("a", "proj", "text", [1, 0, 0])]);
    const kb = openKnowledgeBase({ projectDir: "/tmp/x", driver, embed });
    expect((await kb.getChunk("a")).chunkId).toBe("a");
    await expect(kb.getChunk("nope")).rejects.toBeInstanceOf(UnknownChunkError);
  });

  it("degrades to KNOWLEDGE-only: a memory-only search returns [] (no sidecar)", async () => {
    const kb = openKnowledgeBase({
      projectDir: "/tmp/x",
      driver: new InMemoryVectorDriver(),
      embed,
    });
    expect(await kb.search("q", "proj", 4, new Set(["memory"]))).toStrictEqual([]);
  });

  it("with no explicit embedder, falls back to the built-in hashing default (no throw)", async () => {
    // Previously this threw NotImplementedYet; now the KB works out of the box
    // (pure-TS hashing embedder). Empty index → empty results, never an error.
    const kb = openKnowledgeBase({ projectDir: "/tmp/x", driver: new InMemoryVectorDriver() });
    await expect(kb.search("q", "proj", 4, new Set(["knowledge"]))).resolves.toStrictEqual([]);
  });

  it("a configured vector_db_url selects the (stubbed) Qdrant driver", () => {
    expect(() =>
      openKnowledgeBase({ projectDir: "/tmp/x", vectorDbUrl: "http://localhost:6333" }),
    ).toThrow(NotImplementedYetError);
  });
});

describe("GolemKnowledgeBase MEMORY-scope federation (R3.6)", () => {
  const embed: EmbedFn = (texts) =>
    Promise.resolve(
      texts.map((t) =>
        t.includes("deploy") ? [1, 0, 0] : t.includes("add") ? [0, 1, 0] : [0, 0, 1],
      ),
    );

  function fakeMemorySearch(facts: MemoryFact[] | null): MemorySearchProvider {
    return { search: () => Promise.resolve(facts) };
  }

  it("memory-only search with a provider returns memory hits with a memory: chunk id", async () => {
    const kb = openKnowledgeBase({
      projectDir: "/tmp/x",
      driver: new InMemoryVectorDriver(),
      embed,
      memorySearch: fakeMemorySearch([
        { id: "f1", content: "we decided X", score: 0.9, metadata: { k: "v" } },
      ]),
    });
    const hits = await kb.search("q", "proj", 4, new Set(["memory"]));
    expect(hits).toHaveLength(1);
    expect(hits[0]?.scope).toBe("memory");
    expect(hits[0]?.chunk.chunkId).toBe("memory:f1");
    expect(isMemoryChunkId(hits[0]?.chunk.chunkId ?? "")).toBe(true);
    expect(hits[0]?.chunk.text).toBe("we decided X");
  });

  it("merges knowledge + memory hits when both scopes are requested, sorted by score", async () => {
    const driver = new InMemoryVectorDriver();
    await driver.upsert("proj", [rec("deploy-doc", "proj", "deploy guide", [1, 0, 0])]);
    const kb = openKnowledgeBase({
      projectDir: "/tmp/x",
      driver,
      embed,
      memorySearch: fakeMemorySearch([
        { id: "f1", content: "a stronger memory fact", score: 5, metadata: {} },
      ]),
    });
    const hits = await kb.search("how do I deploy?", "proj", 4);
    expect(hits.map((h) => h.scope)).toStrictEqual(["memory", "knowledge"]);
    expect(hits[0]?.chunk.chunkId).toBe("memory:f1");
    expect(hits[1]?.chunk.chunkId).toBe("deploy-doc");
  });

  it("degrades gracefully to knowledge-only when the memory provider resolves null", async () => {
    const driver = new InMemoryVectorDriver();
    await driver.upsert("proj", [rec("deploy-doc", "proj", "deploy guide", [1, 0, 0])]);
    const kb = openKnowledgeBase({
      projectDir: "/tmp/x",
      driver,
      embed,
      memorySearch: fakeMemorySearch(null),
    });
    const hits = await kb.search("how do I deploy?", "proj", 4);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.chunk.chunkId).toBe("deploy-doc");
  });

  it("without a memorySearch provider, both-scope search still degrades to knowledge-only", async () => {
    const driver = new InMemoryVectorDriver();
    await driver.upsert("proj", [rec("deploy-doc", "proj", "deploy guide", [1, 0, 0])]);
    const kb = openKnowledgeBase({ projectDir: "/tmp/x", driver, embed });
    const hits = await kb.search("how do I deploy?", "proj", 4);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.scope).toBe("knowledge");
  });
});
