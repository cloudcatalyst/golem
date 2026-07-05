/**
 * Auto-index policy: first-run indexes, matching embedder signature is a no-op,
 * and a changed embedder (e.g. lexical → bge-m3) clears + rebuilds. Uses a fake
 * KnowledgeBase so the policy is tested without a real store/embedder.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  embedderSignature,
  ensureProjectIndexed,
  resolveIndexPaths,
} from "../../../src/cli/auto-index.js";
import { HardwareTier } from "../../../src/interfaces/inference.js";
import type { Chunk, IngestReport, KnowledgeBase } from "../../../src/interfaces/knowledge.js";

let projectDir: string;
beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-autoidx-"));
});
afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
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
});
