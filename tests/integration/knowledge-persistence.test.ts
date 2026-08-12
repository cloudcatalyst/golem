/**
 * End-to-end durability: index a real directory through the full KnowledgeBase
 * stack, then open a BRAND-NEW KnowledgeBase over the same project dir (a process
 * restart) and confirm search still finds the content. This is the property the
 * durable FileVectorDriver exists to provide (before it, an index lived only for
 * one `mcp serve` session).
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { EmbedFn } from "../../src/knowledge/index.js";
import { openKnowledgeBase } from "../../src/knowledge/index.js";
import { useTempDirs } from "../helpers/tmp.js";

let projectDir: string;
const newTempDir = useTempDirs("golem-kb-persist-");

beforeEach(async () => {
  projectDir = await newTempDir();
});

/**
 * Deterministic bag-of-words embedder: dimension-fixed vector where each token
 * bumps a hashed slot. Same text → same vector across processes, and texts that
 * share words score higher — enough for a real end-to-end retrieval assertion.
 */
const DIM = 64;
const embed: EmbedFn = (texts) =>
  Promise.resolve(
    texts.map((t) => {
      const v = new Array<number>(DIM).fill(0);
      for (const tok of t.toLowerCase().split(/\W+/)) {
        if (tok === "") continue;
        let h = 0;
        for (let i = 0; i < tok.length; i += 1) h = (h * 31 + tok.charCodeAt(i)) | 0;
        const slot = ((h % DIM) + DIM) % DIM;
        v[slot] = (v[slot] ?? 0) + 1;
      }
      return v;
    }),
  );

describe("knowledge base zero-setup (e2e)", () => {
  it("indexes and searches with NO embed/inference configured (hashing default)", async () => {
    await mkdir(path.join(projectDir, "src"), { recursive: true });
    await writeFile(
      path.join(projectDir, "src", "auth.ts"),
      "export function verifyPassword(user, secret) { return checkArgon2(user, secret); }\n",
    );
    await writeFile(
      path.join(projectDir, "src", "chart.ts"),
      "export function renderLegend(colors) { return colors.map(paintSwatch); }\n",
    );

    // No `embed`, no `inference` — must fall back to the built-in hashing embedder.
    const kb = openKnowledgeBase({ projectDir });
    await kb.ingest(path.join(projectDir, "src"), projectDir);

    const hits = await kb.search("verify password argon2", projectDir, 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.chunk.sourcePath).toContain("auth.ts"); // lexical match beats chart.ts
  });
});

describe("knowledge base durability (e2e)", () => {
  it("finds indexed content from a fresh KB instance after a restart", async () => {
    const projectId = projectDir;
    await mkdir(path.join(projectDir, "src"), { recursive: true });
    await writeFile(
      path.join(projectDir, "src", "auth.ts"),
      "export function verifyPassword(user, secret) {\n  return checkArgon2(user, secret);\n}\n",
    );

    // Session 1: index, then dispose.
    const kb1 = openKnowledgeBase({ projectDir, embed });
    const report = await kb1.ingest(path.join(projectDir, "src"), projectId);
    expect(report.chunksIndexed).toBeGreaterThan(0);

    // Session 2: a brand-new KB over the same dir (= process restart).
    const kb2 = openKnowledgeBase({ projectDir, embed });
    const hits = await kb2.search("verify password argon2", projectId, 5);
    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0];
    expect(top?.chunk.sourcePath).toContain("auth.ts");
    // getChunk resolves the persisted chunk too.
    expect((await kb2.getChunk(top?.chunk.chunkId ?? "")).text).toContain("verifyPassword");
  });
});
