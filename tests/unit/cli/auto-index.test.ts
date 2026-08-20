/**
 * Auto-index policy: first-run indexes, matching embedder signature is a no-op,
 * and a changed embedder (e.g. lexical → bge-m3) clears + rebuilds. Uses a fake
 * KnowledgeBase so the policy is tested without a real store/embedder.
 */

import { mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type EnsureIndexedOptions,
  embedderSignature,
  ensureProjectIndexed,
  INDEX_CHECKPOINT_FILES,
  resolveIndexPaths,
  resolvePersistedEmbedMode,
} from "../../../src/cli/auto-index.js";
import { HardwareTier } from "../../../src/interfaces/inference.js";
import type { Chunk, IngestReport, KnowledgeBase } from "../../../src/interfaces/knowledge.js";
import { collectionDir, knowledgeDir } from "../../../src/knowledge/index.js";
import type { IncrementalIngest } from "../../../src/knowledge/knowledge-base.js";
import { useTempDirs } from "../../helpers/tmp.js";

let projectDir: string;
const newTempDir = useTempDirs("golem-autoidx-");

beforeEach(async () => {
  projectDir = await newTempDir();
});

class SpyKB implements KnowledgeBase {
  readonly ingested: string[] = [];
  async ingest(p: string, projectId: string): Promise<IngestReport> {
    this.ingested.push(p);
    return { path: p, projectId, filesSeen: 2, chunksIndexed: 5, filesSkipped: 0, watching: false };
  }
  async search(): Promise<never[]> {
    return [];
  }
  async getChunk(): Promise<Chunk> {
    throw new Error("not used");
  }
}

/** A SpyKB whose driver DOES support incremental sync (opts into IncrementalIngest). */
class IncrementalSpyKB extends SpyKB implements IncrementalIngest {
  readonly incrementalReady = true;
  readonly reindexed: string[] = [];
  readonly removedPaths: string[] = [];
  async reindexFiles(
    _baseDir: string,
    _projectId: string,
    absFiles: readonly string[],
  ): Promise<number> {
    this.reindexed.push(...absFiles);
    return absFiles.length;
  }
  async removeSourcePaths(_projectId: string, sourcePaths: readonly string[]): Promise<number> {
    this.removedPaths.push(...sourcePaths);
    return sourcePaths.length;
  }
  async ingestText(): Promise<number> {
    return 0;
  }
}

const base = (kb: KnowledgeBase, projectDir: string) => ({
  projectDir,
  projectId: projectDir,
  knowledge: kb,
  watchPaths: [] as string[],
  now: "2026-07-05T00:00:00Z",
});

describe("embedderSignature", () => {
  it("differs between lexical and semantic (so a pull triggers re-index)", () => {
    const lex = embedderSignature("lexical", HardwareTier.PMid);
    const sem = embedderSignature("semantic", HardwareTier.PMid);
    expect(lex).toBe("lexical:hash-v1-512");
    expect(sem).not.toBe(lex);
    expect(sem).toContain("semantic");
  });
});

describe("resolvePersistedEmbedMode", () => {
  it("returns null when there is no index yet", async () => {
    expect(await resolvePersistedEmbedMode(projectDir, projectDir)).toBeNull();
  });

  it("reads back the space a lexical index was built in", async () => {
    await ensureProjectIndexed({ ...base(new SpyKB(), projectDir), embedMode: "lexical", tier: 2 });
    expect(await resolvePersistedEmbedMode(projectDir, projectDir)).toBe("lexical");
  });

  it("reads back the space a semantic index was built in", async () => {
    await ensureProjectIndexed({
      ...base(new SpyKB(), projectDir),
      embedMode: "semantic",
      tier: 2,
    });
    expect(await resolvePersistedEmbedMode(projectDir, projectDir)).toBe("semantic");
  });
});

describe("resolveIndexPaths", () => {
  it("defaults to the project root when no watch_paths", () => {
    expect(resolveIndexPaths("/proj", [])).toStrictEqual(["/proj"]);
  });
  it("roots relative watch_paths, leaves absolute ones", () => {
    expect(resolveIndexPaths("/proj", ["src", "/abs/docs"])).toStrictEqual([
      path.join("/proj", "src"),
      "/abs/docs",
    ]);
  });
});

describe("ensureProjectIndexed", () => {
  it("indexes on first run (no manifest) and writes one", async () => {
    const kb = new SpyKB();
    const r = await ensureProjectIndexed({
      ...base(kb, projectDir),
      embedMode: "lexical",
      tier: 2,
    });
    expect(r.action).toBe("indexed");
    expect(r.chunks).toBe(5);
    expect(kb.ingested).toStrictEqual([projectDir]);
  });

  it("is a no-op when the signature already matches", async () => {
    const kb = new SpyKB();
    await ensureProjectIndexed({ ...base(kb, projectDir), embedMode: "lexical", tier: 2 });
    const kb2 = new SpyKB();
    const r = await ensureProjectIndexed({
      ...base(kb2, projectDir),
      embedMode: "lexical",
      tier: 2,
    });
    expect(r.action).toBe("skipped");
    expect(kb2.ingested).toStrictEqual([]);
  });

  it("re-indexes when the embedder changed (lexical → semantic upgrade)", async () => {
    await ensureProjectIndexed({ ...base(new SpyKB(), projectDir), embedMode: "lexical", tier: 2 });
    const kb = new SpyKB();
    const r = await ensureProjectIndexed({
      ...base(kb, projectDir),
      embedMode: "semantic",
      tier: 2,
    });
    expect(r.action).toBe("reindexed");
    expect(kb.ingested).toStrictEqual([projectDir]);
  });

  it("falls back to a full rebuild when the driver doesn't support incremental sync", async () => {
    await writeFile(path.join(projectDir, "a.txt"), "hello", "utf8");
    await ensureProjectIndexed({ ...base(new SpyKB(), projectDir), embedMode: "lexical", tier: 2 });

    // Plant a sentinel inside the prior index dir: only surviving if the
    // fallback skips the "clear the dir first" step it's meant to always take.
    const dir = collectionDir(knowledgeDir(projectDir), projectDir);
    const sentinel = path.join(dir, "sentinel.txt");
    await writeFile(sentinel, "stale", "utf8");

    // Change the watched file so a sync is triggered under a matching signature.
    await writeFile(path.join(projectDir, "a.txt"), "hello world", "utf8");
    await utimes(path.join(projectDir, "a.txt"), new Date(2000), new Date(2000));

    const kb2 = new SpyKB();
    const r = await ensureProjectIndexed({
      ...base(kb2, projectDir),
      embedMode: "lexical",
      tier: 2,
    });

    expect(r.action).toBe("reindexed");
    // Full-index path (ingest over the root), not the incremental one.
    expect(kb2.ingested).toStrictEqual([projectDir]);
    // The stale index dir was wiped (rm recursive/force) before the rebuild.
    await expect(stat(sentinel)).rejects.toThrow();
  });

  it("falls back to a full rebuild with multiple watch_paths roots, even when the driver supports incremental", async () => {
    await mkdir(path.join(projectDir, "a"));
    await mkdir(path.join(projectDir, "b"));
    await writeFile(path.join(projectDir, "a", "one.txt"), "one", "utf8");
    await writeFile(path.join(projectDir, "b", "two.txt"), "two", "utf8");
    const multi = (kb: KnowledgeBase) => ({
      ...base(kb, projectDir),
      watchPaths: ["a", "b"],
      embedMode: "lexical" as const,
      tier: 2 as const,
    });

    await ensureProjectIndexed(multi(new IncrementalSpyKB()));

    await writeFile(path.join(projectDir, "a", "one.txt"), "one changed", "utf8");
    await utimes(path.join(projectDir, "a", "one.txt"), new Date(2000), new Date(2000));

    const kb2 = new IncrementalSpyKB();
    const r = await ensureProjectIndexed(multi(kb2));

    expect(r.action).toBe("reindexed");
    expect(kb2.ingested).toStrictEqual([path.join(projectDir, "a"), path.join(projectDir, "b")]);
    // Incremental capability was available but unused — multiple roots forced the rebuild.
    expect(kb2.reindexed).toStrictEqual([]);
    expect(kb2.removedPaths).toStrictEqual([]);
  });
});

/** Touch `count` files so the next run sees them as changed. */
async function writeFiles(dir: string, count: number, body: string): Promise<void> {
  for (let i = 0; i < count; i++) {
    const p = path.join(dir, `f${String(i).padStart(3, "0")}.txt`);
    await writeFile(p, `${body} ${i}`, "utf8");
    // A distinct mtime per body, so a rewrite is always a detectable change.
    await utimes(p, new Date(2000 + body.length), new Date(2000 + body.length));
  }
}

describe("ensureProjectIndexed checkpoints its progress (R11.2)", () => {
  /** An incremental KB that dies partway, like a session ending mid-sync. */
  class DyingIncrementalKB extends IncrementalSpyKB {
    batches = 0;
    constructor(readonly dieOnBatch: number) {
      super();
    }
    override async reindexFiles(
      baseDir: string,
      projectId: string,
      absFiles: readonly string[],
    ): Promise<number> {
      this.batches += 1;
      if (this.batches >= this.dieOnBatch) throw new Error("session ended mid-sync");
      return super.reindexFiles(baseDir, projectId, absFiles);
    }
  }

  const inc = (kb: KnowledgeBase, extra: Partial<EnsureIndexedOptions> = {}) => ({
    ...base(kb, projectDir),
    embedMode: "lexical" as const,
    tier: 2 as const,
    ...extra,
  });

  it("keeps the files an interrupted run finished, so the next run only does the rest", async () => {
    const total = INDEX_CHECKPOINT_FILES + 5;
    await writeFiles(projectDir, total, "one");
    await ensureProjectIndexed(inc(new IncrementalSpyKB()));

    await writeFiles(projectDir, total, "two changed");

    // Dies at the START of the second batch: batch 1 is embedded and checkpointed.
    const dying = new DyingIncrementalKB(2);
    await expect(ensureProjectIndexed(inc(dying))).rejects.toThrow("session ended mid-sync");
    expect(dying.reindexed).toHaveLength(INDEX_CHECKPOINT_FILES);

    // The rerun re-embeds ONLY what the dead run never got to. Before
    // checkpointing this was all `total` again, every session, forever.
    const resumed = new IncrementalSpyKB();
    const r = await ensureProjectIndexed(inc(resumed));
    expect(r.action).toBe("synced");
    expect(r.updated).toBe(5);
    expect(resumed.reindexed).toHaveLength(5);

    // And once it completes, nothing is left pending.
    const after = new IncrementalSpyKB();
    expect((await ensureProjectIndexed(inc(after))).action).toBe("skipped");
    expect(after.reindexed).toStrictEqual([]);
  });

  it("checkpoints deletions before spending anything on embedding", async () => {
    await writeFiles(projectDir, 3, "one");
    await ensureProjectIndexed(inc(new IncrementalSpyKB()));
    // One file deleted, the others edited — so the run has both kinds of work.
    await rm(path.join(projectDir, "f000.txt"));
    for (const name of ["f001.txt", "f002.txt"]) {
      const p = path.join(projectDir, name);
      await writeFile(p, "two changed", "utf8");
      await utimes(p, new Date(3000), new Date(3000));
    }

    // Dies on the FIRST embed batch — only the removal can have been recorded.
    const dying = new DyingIncrementalKB(1);
    await expect(ensureProjectIndexed(inc(dying))).rejects.toThrow();
    expect(dying.removedPaths).toStrictEqual(["f000.txt"]);

    const resumed = new IncrementalSpyKB();
    const r = await ensureProjectIndexed(inc(resumed));
    expect(r.action).toBe("synced");
    expect(resumed.removedPaths).toStrictEqual([]); // the delete is not redone
  });
});

describe("ensureProjectIndexed defers past the auto-index cap (R11.2)", () => {
  const inc = (kb: KnowledgeBase, extra: Partial<EnsureIndexedOptions> = {}) => ({
    ...base(kb, projectDir),
    embedMode: "lexical" as const,
    tier: 2 as const,
    ...extra,
  });

  it("embeds nothing and says how to sync when more files changed than the cap", async () => {
    await writeFiles(projectDir, 3, "one");
    await ensureProjectIndexed(inc(new IncrementalSpyKB()));
    await writeFiles(projectDir, 3, "two changed");

    const kb = new IncrementalSpyKB();
    const logs: string[] = [];
    const r = await ensureProjectIndexed(
      inc(kb, { maxAutoFiles: 2, log: (m: string) => logs.push(m) }),
    );

    expect(r.action).toBe("deferred");
    expect(r.updated).toBe(3);
    expect(kb.reindexed).toStrictEqual([]);
    expect(logs.join("\n")).toContain("golem index");

    // Deferred, not lost: the explicit (uncapped) run still has all 3 to do.
    const explicit = new IncrementalSpyKB();
    const r2 = await ensureProjectIndexed(inc(explicit));
    expect(r2.action).toBe("synced");
    expect(explicit.reindexed).toHaveLength(3);
  });

  it("syncs normally at or below the cap", async () => {
    await writeFiles(projectDir, 2, "one");
    await ensureProjectIndexed(inc(new IncrementalSpyKB()));
    await writeFiles(projectDir, 2, "two changed");

    const kb = new IncrementalSpyKB();
    const r = await ensureProjectIndexed(inc(kb, { maxAutoFiles: 2 }));
    expect(r.action).toBe("synced");
    expect(kb.reindexed).toHaveLength(2);
  });

  it("never blocks the first-run build — an unindexed project has no search at all", async () => {
    await writeFiles(projectDir, 5, "one");
    const kb = new SpyKB();
    const r = await ensureProjectIndexed(inc(kb, { maxAutoFiles: 1 }));
    expect(r.action).toBe("indexed");
    expect(kb.ingested).toStrictEqual([projectDir]);
  });
});
