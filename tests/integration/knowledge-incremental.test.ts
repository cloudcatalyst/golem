/**
 * Incremental freshness (auto-index sync): after the first index, editing a file,
 * adding one, and deleting one are each reflected on the next `ensureProjectIndexed`
 * WITHOUT a full rebuild — and an embedder change still triggers a full rebuild.
 *
 * Uses the real GolemKnowledgeBase + FileVectorDriver + hashing embedder (no
 * Ollama), so it exercises the actual delete-by-source + re-chunk path.
 */

import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureProjectIndexed } from "../../src/cli/auto-index.js";
import { openKnowledgeBase } from "../../src/knowledge/index.js";
import { rmTemp } from "../helpers/tmp.js";

let projectDir: string;
beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-inc-"));
});
afterEach(async () => {
  await rm(projectDir, rmTemp);
});

const write = (rel: string, body: string) => writeFile(path.join(projectDir, rel), body, "utf8");

/** ensureProjectIndexed with the real hashing KB over the project dir. */
function sync(now: string, embedMode: "lexical" | "semantic" = "lexical") {
  return ensureProjectIndexed({
    projectDir,
    projectId: projectDir,
    knowledge: openKnowledgeBase({ projectDir }),
    embedMode,
    tier: 2,
    watchPaths: [],
    now,
  });
}

/** Source paths of hits for a query, via a fresh KB over the persisted index. */
async function search(query: string): Promise<string[]> {
  const kb = openKnowledgeBase({ projectDir });
  const hits = await kb.search(query, projectDir, 10);
  return hits.map((h) => h.chunk.sourcePath ?? "");
}

/** Full text of every currently-indexed chunk (to assert stale content is gone). */
async function allText(): Promise<string> {
  const kb = openKnowledgeBase({ projectDir });
  const hits = await kb.search("function export const", projectDir, 100);
  return hits.map((h) => h.chunk.text).join("\n");
}

describe("incremental auto-index", () => {
  it("first run indexes; unchanged second run is a no-op", async () => {
    await write("alpha.ts", "export function alphaHandler() { return 1; }\n");
    const r1 = await sync("t1");
    expect(r1.action).toBe("indexed");
    const r2 = await sync("t2");
    expect(r2.action).toBe("skipped");
  });

  it("reflects a NEW file via incremental sync (not a full rebuild)", async () => {
    await write("alpha.ts", "export function alphaHandler() {}\n");
    await sync("t1");
    await write("beta.ts", "export function betaWidget() {}\n");
    const r = await sync("t2");
    expect(r.action).toBe("synced");
    expect(r.updated).toBe(1);
    expect(await search("beta widget")).toContain("beta.ts");
  });

  it("reflects an EDITED file (old chunk replaced, no orphan)", async () => {
    await write("mod.ts", "export function originalConcept() {}\n");
    await sync("t1");
    expect(await allText()).toContain("originalConcept");

    await write("mod.ts", "export function replacementNotion() {}\n");
    // Bump mtime deterministically (some filesystems have coarse mtime).
    await utimes(path.join(projectDir, "mod.ts"), new Date(2000), new Date(2000));
    const r = await sync("t2");
    expect(r.action).toBe("synced");
    // Content-based ids: the stale chunk must be DELETED, not orphaned alongside.
    const text = await allText();
    expect(text).toContain("replacementNotion");
    expect(text).not.toContain("originalConcept");
  });

  it("drops a DELETED file's chunks", async () => {
    await write("keep.ts", "export function keepThis() {}\n");
    await write("gone.ts", "export function transientRoutine() {}\n");
    await sync("t1");
    expect(await search("transient routine")).toContain("gone.ts");

    await rm(path.join(projectDir, "gone.ts"));
    const r = await sync("t2");
    expect(r.action).toBe("synced");
    expect(r.removed).toBe(1);
    expect(await search("transient routine")).not.toContain("gone.ts");
    expect(await search("keep this")).toContain("keep.ts");
  });

  it("embedder change forces a full rebuild (not incremental)", async () => {
    await write("alpha.ts", "export function alphaHandler() {}\n");
    await sync("t1", "lexical");
    const r = await sync("t2", "semantic");
    expect(r.action).toBe("reindexed");
  });
});
