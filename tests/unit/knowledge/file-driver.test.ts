/**
 * FileVectorDriver — the durable, pure-TS default vector store.
 *
 * Runs the shared VectorDriver contract (search order, per-project isolation,
 * upsert-replace, getChunk) AND the property that makes it worth having: an
 * index survives a fresh driver instance (process restart) reading the same dir.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Chunk } from "../../../src/interfaces/index.js";
import type { StoredChunk } from "../../../src/knowledge/index.js";
import { FileVectorDriver } from "../../../src/knowledge/index.js";

let base: string;
beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "golem-fvd-"));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function chunk(id: string, text: string): Chunk {
  return { chunkId: id, projectId: "p1", text, metadata: {} };
}
function stored(id: string, vector: number[], text = id): StoredChunk {
  return { chunk: chunk(id, text), vector };
}

describe("FileVectorDriver", () => {
  it("searches by cosine similarity, best first, respecting k", async () => {
    const d = new FileVectorDriver(base);
    await d.upsert("p1", [
      stored("a", [1, 0, 0]),
      stored("b", [0.9, 0.1, 0]),
      stored("c", [0, 1, 0]),
    ]);
    const hits = await d.search("p1", [1, 0, 0], 2);
    expect(hits.map((h) => h.chunkId)).toStrictEqual(["a", "b"]);
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 1);
  });

  it("isolates projects and resolves chunks globally", async () => {
    const d = new FileVectorDriver(base);
    await d.upsert("p1", [stored("a", [1, 0])]);
    await d.upsert("p2", [stored("b", [1, 0])]);
    expect((await d.search("p1", [1, 0], 5)).map((h) => h.chunkId)).toStrictEqual(["a"]);
    expect((await d.getChunk("b"))?.chunkId).toBe("b");
    expect(await d.getChunk("missing")).toBeNull();
  });

  it("upsert replaces a record by chunkId (no duplicates)", async () => {
    const d = new FileVectorDriver(base);
    await d.upsert("p1", [stored("a", [1, 0], "old")]);
    await d.upsert("p1", [stored("a", [1, 0], "new")]);
    const hits = await d.search("p1", [1, 0], 5);
    expect(hits).toHaveLength(1);
    expect((await d.getChunk("a"))?.text).toBe("new");
  });

  it("PERSISTS across a fresh driver instance (the whole point)", async () => {
    const write = new FileVectorDriver(base);
    await write.upsert("proj", [stored("x", [1, 0, 0], "durable"), stored("y", [0, 1, 0])]);
    await write.close();

    // A brand-new instance over the same dir = a process restart.
    const read = new FileVectorDriver(base);
    const hits = await read.search("proj", [1, 0, 0], 5);
    expect(hits[0]?.chunkId).toBe("x");
    expect((await read.getChunk("x"))?.text).toBe("durable");
  });

  it("treats a future schema version as empty (re-index), never crashes", async () => {
    const d = new FileVectorDriver(base);
    await d.upsert("proj", [stored("x", [1, 0])]);
    await d.close();
    // Corrupt the meta to a newer schema than we understand.
    const { createHash } = await import("node:crypto");
    const dir = path.join(base, createHash("sha256").update("proj").digest("hex").slice(0, 16));
    await writeFile(path.join(dir, "meta.json"), JSON.stringify({ schemaVersion: 999, dim: 2 }));

    const read = new FileVectorDriver(base);
    expect(await read.search("proj", [1, 0], 5)).toStrictEqual([]);
    // ...and re-indexing over it works.
    await read.upsert("proj", [stored("z", [1, 0])]);
    expect((await read.search("proj", [1, 0], 5)).map((h) => h.chunkId)).toStrictEqual(["z"]);
  });

  it("skips a corrupt JSONL line rather than failing the load", async () => {
    const d = new FileVectorDriver(base);
    await d.upsert("proj", [stored("good", [1, 0])]);
    await d.close();
    const { createHash } = await import("node:crypto");
    const dir = path.join(base, createHash("sha256").update("proj").digest("hex").slice(0, 16));
    const file = path.join(dir, "chunks.jsonl");
    const body = await readFile(file, "utf8");
    await writeFile(file, `${body}{ this is not json\n`);

    const read = new FileVectorDriver(base);
    expect((await read.search("proj", [1, 0], 5)).map((h) => h.chunkId)).toStrictEqual(["good"]);
  });
});
