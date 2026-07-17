/**
 * KnowledgeLocalAnswerService prose-source restriction (verification-notes §69b,
 * Decision 33 finding #2). The extractive local-answer path must NOT serve raw
 * code/test chunks — even when they outrank prose — because they are almost never
 * a good answer to a definitional question and were the source of confident-wrong
 * served answers (e.g. `const LEVEL_0 = …` for "slider level 0"). It serves only
 * from prose sources; if none clears the floor it declines.
 */

import { describe, expect, it } from "vitest";
import type { FederatedSearch, Hit, Scope } from "../../../src/interfaces/knowledge.js";
import { isProseSource, KnowledgeLocalAnswerService } from "../../../src/knowledge/local-answer.js";

function hit(sourcePath: string, score: number, text = `chunk of ${sourcePath}`): Hit {
  return {
    chunk: { chunkId: sourcePath, projectId: "p", text, sourcePath, metadata: {} },
    score,
    scope: "knowledge",
  };
}

/** A fake FederatedSearch that returns a fixed hit list (already score-sorted). */
function fakeSearch(hits: Hit[]): FederatedSearch {
  return {
    search: (_q: string, _p: string, k = hits.length, _s?: ReadonlySet<Scope>) =>
      Promise.resolve(hits.slice(0, k)),
    // Unused by tryAnswer (it composes from the Hit chunks directly), but part of
    // the FederatedSearch contract.
    getChunk: (chunkId: string) => Promise.reject(new Error(`unexpected getChunk(${chunkId})`)),
  };
}

describe("isProseSource", () => {
  it("accepts durable prose (wiki/spec/root docs), rejects code, tests, and working docs", () => {
    // Durable prose — served.
    expect(isProseSource("docs/wiki/concepts/Redaction Stage.md")).toBe(true);
    expect(isProseSource("docs/golem-spec.md")).toBe(true);
    expect(isProseSource("README.md")).toBe(true);
    expect(isProseSource("notes.txt")).toBe(true);
    // Code + tests — never.
    expect(isProseSource("src\\interfaces\\policy.ts")).toBe(false); // windows sep
    expect(isProseSource("tests/unit/compression/native-lossless.test.ts")).toBe(false);
    expect(isProseSource("src/cli/skills.ts")).toBe(false);
    // Working/planning docs — prose, but ephemeral working state, not answers.
    expect(isProseSource("docs/plan/IMPLEMENTATION_PLAN.md")).toBe(false);
    expect(isProseSource("docs/plan/verification-notes.md")).toBe(false);
    expect(isProseSource("docs/plan/ROADMAP.md")).toBe(false);
    expect(isProseSource(undefined)).toBe(false);
  });
});

describe("KnowledgeLocalAnswerService prose restriction", () => {
  it("does NOT serve a high-scoring code/test hit; declines when only code clears the floor", async () => {
    // The §69b failure: a test constant outranks everything but is a useless answer.
    const svc = new KnowledgeLocalAnswerService(
      fakeSearch([
        hit("tests/unit/compression/native-lossless.test.ts", 0.7, "const LEVEL_0 = ..."),
        hit("src/interfaces/policy.ts", 0.64, "export type SliderLevel = 0 | 1 | 2 | 3;"),
      ]),
    );
    const res = await svc.tryAnswer({ text: "what does slider level 0 mean?", projectId: "p" });
    expect(res.answered).toBe(false);
  });

  it("serves a prose hit that clears the floor, even when a code hit scored higher", async () => {
    const svc = new KnowledgeLocalAnswerService(
      fakeSearch([
        hit("src/mcp/server.ts", 0.72, "code that mentions redaction"),
        hit("docs/wiki/concepts/Redaction Stage.md", 0.63, "Golem strips secrets/PII before ..."),
      ]),
    );
    const res = await svc.tryAnswer({ text: "what is the redaction stage?", projectId: "p" });
    expect(res.answered).toBe(true);
    if (res.answered) {
      expect(res.sources.map((s) => s.sourcePath)).toStrictEqual([
        "docs/wiki/concepts/Redaction Stage.md",
      ]);
      expect(res.text).toContain("strips secrets/PII");
    }
  });

  it("declines when a prose hit exists but is below the confidence floor", async () => {
    const svc = new KnowledgeLocalAnswerService(
      fakeSearch([hit("CLAUDE.md", 0.55, "Golem is a universal pre-LLM processing layer")]),
    );
    const res = await svc.tryAnswer({ text: "what is golem?", projectId: "p" });
    expect(res.answered).toBe(false);
  });
});
