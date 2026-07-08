/**
 * Runs the frozen KnowledgeBase contract against GolemKnowledgeBase backed by
 * FileVectorDriver — the durable, pure-TS driver `openKnowledgeBase()` selects
 * by default (src/knowledge/index.ts `selectDriver`) and therefore what
 * actually ships to users. The contract already runs against
 * InMemoryVectorDriver (tests/unit/knowledge/ingest.test.ts); until now the
 * driver that real installs use had never been checked against it.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { type EmbedFn, openKnowledgeBase } from "../../../src/knowledge/index.js";
import { describeKnowledgeBaseContract } from "../../contract/knowledge-contract.js";

/**
 * Deterministic lexical embedder: hashes tokens into a fixed-dim bag-of-words
 * vector. Same helper as tests/unit/knowledge/ingest.test.ts — kept as a local
 * copy rather than a shared export since it's a small, self-contained test
 * fixture used in exactly two files.
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

// Each contract test calls makeKb() fresh, so a fresh temp dir per call keeps
// every test hermetic and safe to run in parallel — mirroring how the
// InMemoryVectorDriver-backed run in ingest.test.ts gets a brand-new driver
// instance per test.
const projectDirs: string[] = [];
afterEach(async () => {
  await Promise.all(projectDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describeKnowledgeBaseContract("GolemKnowledgeBase (FileVectorDriver)", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "golem-fvd-contract-"));
  projectDirs.push(projectDir);
  // No `driver` override: FileVectorDriver is openKnowledgeBase()'s default.
  return openKnowledgeBase({ projectDir, embed: lexicalEmbed() });
});
