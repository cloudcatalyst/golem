/**
 * Reusable contract harness for KnowledgeBase implementations (WS-C).
 *
 * The harness creates a small corpus in a temp directory per test.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { KnowledgeBase } from "../../src/interfaces/knowledge.js";
import { UnknownChunkError } from "../../src/interfaces/knowledge.js";

const PROJECT = "contract-test-project";
const KNOWLEDGE_ONLY: ReadonlySet<"knowledge"> = new Set(["knowledge"] as const);

async function makeCorpus(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eol-kb-contract-"));
  await writeFile(
    join(dir, "guide.md"),
    "# Deploy guide\n\nAlways run migrations before deploying.\n",
    "utf8",
  );
  await writeFile(
    join(dir, "util.ts"),
    "export function add(a: number, b: number) { return a + b; }\n",
    "utf8",
  );
  return dir;
}

export function describeKnowledgeBaseContract(
  name: string,
  makeKb: () => KnowledgeBase | Promise<KnowledgeBase>,
): void {
  describe(`KnowledgeBase contract: ${name}`, () => {
    const corpora: string[] = [];

    afterEach(async () => {
      await Promise.all(corpora.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    async function corpus(): Promise<string> {
      const dir = await makeCorpus();
      corpora.push(dir);
      return dir;
    }

    it("ingest reports counts", async () => {
      const kb = await makeKb();
      const report = await kb.ingest(await corpus(), PROJECT);
      expect(report.projectId).toBe(PROJECT);
      expect(report.filesSeen).toBeGreaterThanOrEqual(2);
      expect(report.chunksIndexed).toBeGreaterThanOrEqual(1);
    });

    it("search returns ranked knowledge-scope hits for on-corpus queries", async () => {
      const kb = await makeKb();
      await kb.ingest(await corpus(), PROJECT);
      const hits = await kb.search("how do I deploy?", PROJECT, 4, KNOWLEDGE_ONLY);
      expect(hits.length).toBeGreaterThan(0);
      const scores = hits.map((h) => h.score);
      expect(scores).toStrictEqual([...scores].sort((a, b) => b - a));
      expect(hits.every((h) => h.scope === "knowledge")).toBe(true);
    });

    it("getChunk round-trips", async () => {
      const kb = await makeKb();
      await kb.ingest(await corpus(), PROJECT);
      const hits = await kb.search("migrations", PROJECT, 1, KNOWLEDGE_ONLY);
      const first = hits[0];
      expect(first).toBeDefined();
      if (!first) return;
      const chunk = await kb.getChunk(first.chunk.chunkId);
      expect(chunk.chunkId).toBe(first.chunk.chunkId);
      expect(chunk.text.length).toBeGreaterThan(0);
    });

    it("unknown chunk ids reject with UnknownChunkError", async () => {
      const kb = await makeKb();
      await expect(kb.getChunk("does-not-exist")).rejects.toBeInstanceOf(UnknownChunkError);
    });

    it("no cross-project bleed (per-project collections)", async () => {
      const kb = await makeKb();
      await kb.ingest(await corpus(), PROJECT);
      const hits = await kb.search("migrations", "some-other-project", 4, KNOWLEDGE_ONLY);
      expect(hits).toHaveLength(0);
    });
  });
}
