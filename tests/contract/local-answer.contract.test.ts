/**
 * R2.3 — the frozen LocalAnswerService contract, run against the real
 * KnowledgeLocalAnswerService over a real GolemKnowledgeBase (in-memory
 * driver + deterministic lexical embedder, matching the pattern
 * tests/unit/knowledge/ingest.test.ts uses for the KnowledgeBase contract).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import {
  type EmbedFn,
  InMemoryVectorDriver,
  openKnowledgeBase,
} from "../../src/knowledge/index.js";
import { KnowledgeLocalAnswerService } from "../../src/knowledge/local-answer.js";
import { describeLocalAnswerContract } from "./local-answer-contract.js";

/** Same deterministic bag-of-words embedder tests/unit/knowledge/ingest.test.ts uses. */
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

const PROJECT = "contract-test-project";
const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
});

describeLocalAnswerContract("KnowledgeLocalAnswerService", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "golem-local-answer-"));
  tempDirs.push(dir);
  await writeFile(
    path.join(dir, "deploy.md"),
    "# Deployment\n\nHow do I deploy this project? Run npm run build, then golem-run init on the target machine.\n",
  );
  const kb = openKnowledgeBase({
    projectDir: dir,
    driver: new InMemoryVectorDriver(),
    embed: lexicalEmbed(),
  });
  await kb.ingest(dir, PROJECT);
  // Production default (DEFAULT_MIN_CONFIDENCE) — measured against this
  // fixture, the matching query scores ~0.66 and an unrelated one ~0.06,
  // comfortably on either side of the 0.6 floor.
  return new KnowledgeLocalAnswerService(kb);
});
