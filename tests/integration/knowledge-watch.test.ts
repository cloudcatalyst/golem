/**
 * T6 (C2 follow-up) — `GolemKnowledgeBase.ingest(path, projectId, true)` wired
 * end-to-end: a new file appears in search after a live edit, a deleted file's
 * chunks disappear, all without a second `ingest()` call. Real fs events, real
 * debounce timing (default 500ms) — this is the one slower test that proves
 * the full watchPath -> reindexFiles/removeSourcePaths wiring, not just the
 * watcher in isolation (see tests/unit/knowledge/file-watcher.test.ts).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GolemKnowledgeBase,
  hashingEmbedFn,
  InMemoryVectorDriver,
} from "../../src/knowledge/index.js";
import { rmTemp } from "../helpers/tmp.js";

let dir: string;
let kb: GolemKnowledgeBase;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "golem-kb-watch-"));
  kb = new GolemKnowledgeBase(new InMemoryVectorDriver(), { embed: hashingEmbedFn() });
});

afterEach(async () => {
  kb.closeWatchers();
  await rm(dir, rmTemp);
});

async function searchFor(query: string): Promise<string[]> {
  const hits = await kb.search(query, dir, 10);
  return hits.map((h) => h.chunk.sourcePath ?? "");
}

/** Polls a predicate until it's true, for waiting out the watcher's debounce + reindex. */
async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("GolemKnowledgeBase.ingest watch mode", () => {
  it("reports watching:true and starts empty", async () => {
    const report = await kb.ingest(dir, dir, true);
    expect(report.watching).toBe(true);
    expect(report.filesSeen).toBe(0);
  });

  it("picks up a file created after ingest starts watching", async () => {
    await kb.ingest(dir, dir, true);
    await writeFile(path.join(dir, "alpha.md"), "# alphaWidget marker\n");

    await waitUntil(async () => (await searchFor("alphaWidget marker")).includes("alpha.md"));
  });

  it("drops a file's chunks after it's deleted", async () => {
    await writeFile(path.join(dir, "beta.md"), "# betaGadget marker\n");
    await kb.ingest(dir, dir, true);
    await waitUntil(async () => (await searchFor("betaGadget marker")).includes("beta.md"));

    await rm(path.join(dir, "beta.md"));
    await waitUntil(async () => !(await searchFor("betaGadget marker")).includes("beta.md"));
  });
});
