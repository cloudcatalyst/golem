/**
 * FileVectorDriver — the durable, pure-TS default vector store.
 *
 * Runs the shared VectorDriver contract (search order, per-project isolation,
 * upsert-replace, getChunk) AND the property that makes it worth having: an
 * index survives a fresh driver instance (process restart) reading the same dir.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Chunk } from "../../../src/interfaces/index.js";
import type { StoredChunk } from "../../../src/knowledge/index.js";
import {
  canonicalProjectId,
  collectionDir,
  EmbedderMismatchError,
  FileVectorDriver,
} from "../../../src/knowledge/index.js";
import { useTempDirs } from "../../helpers/tmp.js";

let base: string;
const newTempDir = useTempDirs("golem-fvd-");

beforeEach(async () => {
  base = await newTempDir();
});

function chunk(id: string, text: string): Chunk {
  return { chunkId: id, projectId: "p1", text, metadata: {} };
}
function stored(id: string, vector: number[], text = id): StoredChunk {
  return { chunk: chunk(id, text), vector };
}

describe("canonicalProjectId", () => {
  it("uppercases a lowercase leading Windows drive letter", () => {
    expect(canonicalProjectId("d:\\Personar\\repo")).toBe("D:\\Personar\\repo");
  });
  it("leaves an already-uppercase drive letter untouched", () => {
    expect(canonicalProjectId("D:\\Personar\\repo")).toBe("D:\\Personar\\repo");
  });
  it("collapses drive-letter case so both cases hash to one collection", () => {
    expect(canonicalProjectId("d:\\Personar\\repo")).toBe(canonicalProjectId("D:\\Personar\\repo"));
    expect(collectionDir("/base", "d:\\Personar\\repo")).toBe(
      collectionDir("/base", "D:\\Personar\\repo"),
    );
  });
  it("canonicalizes a drive-relative path too (c:foo → C:foo)", () => {
    expect(canonicalProjectId("c:foo")).toBe("C:foo");
  });
  it("is a no-op for POSIX paths, bare ids, and the empty string", () => {
    expect(canonicalProjectId("/home/user/repo")).toBe("/home/user/repo");
    expect(canonicalProjectId("proj")).toBe("proj");
    expect(canonicalProjectId("")).toBe("");
  });

  it("folds forward slashes so `d:/repo` and `D:\\repo` are one collection", () => {
    expect(canonicalProjectId("d:/Personar/repo")).toBe("D:\\Personar\\repo");
    expect(collectionDir("/base", "d:/Personar/repo")).toBe(
      collectionDir("/base", "D:\\Personar\\repo"),
    );
  });

  it("drops a trailing separator so `D:\\repo\\` is the same collection as `D:\\repo`", () => {
    expect(canonicalProjectId("D:\\Personar\\repo\\")).toBe("D:\\Personar\\repo");
    expect(canonicalProjectId("d:/Personar/repo/")).toBe("D:\\Personar\\repo");
    expect(collectionDir("/base", "D:\\Personar\\repo\\")).toBe(
      collectionDir("/base", "D:\\Personar\\repo"),
    );
  });

  it("never trims the root away (a drive root is not the drive-relative path)", () => {
    expect(canonicalProjectId("d:\\")).toBe("D:\\");
    expect(canonicalProjectId("d:\\\\")).toBe("D:\\");
    expect(canonicalProjectId("d:/")).toBe("D:\\");
    expect(canonicalProjectId("d:")).toBe("D:");
    expect(canonicalProjectId("D:\\")).not.toBe(canonicalProjectId("D:"));
  });

  it("leaves backslashes in POSIX ids alone (a legal filename character there)", () => {
    expect(canonicalProjectId("/home/user/we\\ird")).toBe("/home/user/we\\ird");
    expect(canonicalProjectId("repo/")).toBe("repo/");
  });
  it("only rewrites the drive letter, never the rest of the path's case", () => {
    expect(canonicalProjectId("d:\\Foo\\BarBaz")).toBe("D:\\Foo\\BarBaz");
  });

  it(
    "collapses a git linked worktree to its main checkout's id, agreeing with " +
      "the CCR store's identical decision (task ccr-ref-scope — same shared " +
      "resolveWorktreeRoot, docs/wiki/concepts/CCR Ref Scope.md)",
    async () => {
      const mainRoot = path.join(base, "main-checkout");
      const sharedGitDir = path.join(mainRoot, ".git");
      const worktreeRoot = path.join(base, "agent-worktree");
      const worktreeGitDir = path.join(sharedGitDir, "worktrees", "agent-worktree");

      await mkdir(sharedGitDir, { recursive: true });
      await mkdir(worktreeGitDir, { recursive: true });
      await mkdir(worktreeRoot, { recursive: true });
      await writeFile(path.join(worktreeGitDir, "commondir"), "../..\n", "utf8");
      await writeFile(path.join(worktreeRoot, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");

      expect(canonicalProjectId(worktreeRoot)).toBe(canonicalProjectId(mainRoot));
      expect(collectionDir("/base", worktreeRoot)).toBe(collectionDir("/base", mainRoot));
    },
  );
});

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

  it("throws EmbedderMismatchError on a cross-space query, in-instance and after reload", async () => {
    const d = new FileVectorDriver(base);
    await d.upsert("p1", [stored("a", [1, 0, 0]), stored("b", [0, 1, 0])]);
    // 4-dim query against a 3-dim index: a differently-embedded query that would
    // otherwise score 0 for every chunk and return ranked garbage.
    await expect(d.search("p1", [1, 0, 0, 0], 5)).rejects.toBeInstanceOf(EmbedderMismatchError);
    await d.close();
    // Reload path: `col.dim` is restored from meta.json, so the guard still fires.
    await expect(new FileVectorDriver(base).search("p1", [1, 0, 0, 0], 5)).rejects.toBeInstanceOf(
      EmbedderMismatchError,
    );
    // A correctly-dimensioned query still works normally.
    expect(
      (await new FileVectorDriver(base).search("p1", [1, 0, 0], 5)).map((h) => h.chunkId),
    ).toStrictEqual(["a", "b"]);
  });

  it("resets the collection when the embedder dimension changes on reindex (§69/LE5c)", async () => {
    // Simulates a lexical→semantic reindex (e.g. after `ollama pull bge-m3`):
    // `golem index` re-ingests without clearing, so without this reset the old
    // low-dim chunks would strand under the new signature and every query would
    // throw EmbedderMismatchError. New-dim upsert must drop the old space cleanly.
    const d = new FileVectorDriver(base);
    await d.upsert("p1", [stored("lex1", [1, 0]), stored("lex2", [0, 1])]);
    // Reindex with 3-dim (new embedder) vectors — must wipe the 2-dim chunks.
    await d.upsert("p1", [stored("sem1", [1, 0, 0]), stored("sem2", [0, 1, 0])]);

    const hits = await d.search("p1", [1, 0, 0], 10);
    expect(hits.map((h) => h.chunkId).sort()).toStrictEqual(["sem1", "sem2"]);
    // Old-space chunks are gone from search AND global chunk resolution.
    expect(await d.getChunk("lex1")).toBeNull();
    // Survives a reload with the new dimension persisted.
    await d.close();
    const read = new FileVectorDriver(base);
    expect((await read.search("p1", [0, 1, 0], 10)).map((h) => h.chunkId).sort()).toStrictEqual([
      "sem1",
      "sem2",
    ]);
  });

  it("does NOT reset on a same-dimension incremental reindex", async () => {
    const d = new FileVectorDriver(base);
    await d.upsert("p1", [stored("a", [1, 0, 0]), stored("b", [0, 1, 0])]);
    // Same dim → an incremental add must preserve existing chunks.
    await d.upsert("p1", [stored("c", [0, 0, 1])]);
    expect((await d.search("p1", [1, 0, 0], 10)).map((h) => h.chunkId).sort()).toStrictEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("isolates projects and resolves chunks globally", async () => {
    const d = new FileVectorDriver(base);
    await d.upsert("p1", [stored("a", [1, 0])]);
    await d.upsert("p2", [stored("b", [1, 0])]);
    expect((await d.search("p1", [1, 0], 5)).map((h) => h.chunkId)).toStrictEqual(["a"]);
    expect((await d.getChunk("b"))?.chunkId).toBe("b");
    expect(await d.getChunk("missing")).toBeNull();
  });

  it("deleteBySourcePath removes only that file's chunks and persists", async () => {
    const d = new FileVectorDriver(base);
    const withSource = (id: string, sp: string): StoredChunk => ({
      chunk: { chunkId: id, projectId: "p1", text: id, sourcePath: sp, metadata: {} },
      vector: [1, 0],
    });
    await d.upsert("p1", [
      withSource("a1", "a.ts"),
      withSource("a2", "a.ts"),
      withSource("b1", "b.ts"),
    ]);
    expect(await d.deleteBySourcePath("p1", "a.ts")).toBe(2);
    // b.ts survives, in this instance AND after a reload.
    expect((await d.search("p1", [1, 0], 10)).map((h) => h.chunkId)).toStrictEqual(["b1"]);
    expect(
      (await new FileVectorDriver(base).search("p1", [1, 0], 10)).map((h) => h.chunkId),
    ).toStrictEqual(["b1"]);
  });

  it("deleteBySourcePaths removes several files' chunks in one batch and persists", async () => {
    const d = new FileVectorDriver(base);
    const withSource = (id: string, sp: string): StoredChunk => ({
      chunk: { chunkId: id, projectId: "p1", text: id, sourcePath: sp, metadata: {} },
      vector: [1, 0],
    });
    await d.upsert("p1", [
      withSource("a1", "a.ts"),
      withSource("b1", "b.ts"),
      withSource("c1", "c.ts"),
    ]);
    expect(await d.deleteBySourcePaths("p1", ["a.ts", "b.ts"])).toBe(2);
    expect(await d.deleteBySourcePaths("p1", [])).toBe(0);
    expect(
      (await new FileVectorDriver(base).search("p1", [1, 0], 10)).map((h) => h.chunkId),
    ).toStrictEqual(["c1"]);
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

  it("R4.6: streams a large collection to disk and reloads every record (no lost lines)", async () => {
    // Guards the stream-write flush (r3.7 spike's RangeError fix): thousands of
    // ~1KB records force many internal buffer flushes (drain), so a dropped line
    // or missing trailing newline would surface here. Kept modest so CI stays
    // fast — the full 50k+ crash-wall check is the (uncommitted) scratch bench.
    const n = 3000;
    const big = "x".repeat(1000);
    const records: StoredChunk[] = [];
    for (let i = 0; i < n; i++) records.push(stored(`c${i}`, [i % 7, 1, 0], `${i}:${big}`));
    const write = new FileVectorDriver(base);
    await write.upsert("big", records);
    await write.close();

    // Reload from disk: count and a specific record must survive intact.
    const read = new FileVectorDriver(base);
    await read.openCollection("big");
    expect((await read.getChunk("c0"))?.text).toBe(`0:${big}`);
    expect((await read.getChunk(`c${n - 1}`))?.text).toBe(`${n - 1}:${big}`);
    const hits = await read.search("big", [6, 1, 0], n);
    expect(hits).toHaveLength(n);
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
