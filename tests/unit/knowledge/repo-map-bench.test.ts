/**
 * R8.5 — the gate's own tests. A harness that decides whether a feature ships
 * has to be at least as trustworthy as the feature, so what is asserted here is
 * mostly the ways it must refuse to flatter the map: excluded errors, deltas
 * inside the case set's resolution, and a rotted case set.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ChatOptions,
  ChatResult,
  HardwareTier,
  InferenceService,
} from "../../../src/interfaces/index.js";
import { HardwareTier as Tier } from "../../../src/interfaces/index.js";
import { clearRepoMapCache, scanRepoFiles } from "../../../src/knowledge/repo-map.js";
import {
  benchRepoMap,
  parsePathChoice,
  renderPathList,
  renderRepoMapBench,
} from "../../../src/knowledge/repo-map-bench.js";
import type { RetrievalCase } from "../../../src/knowledge/repo-map-cases.js";

describe("parsePathChoice", () => {
  const known = new Set(["src/a.ts", "src/b/c.ts"]);

  it("accepts the schema'd object, a bare path, and a fenced reply", () => {
    expect(parsePathChoice('{"path": "src/a.ts"}', known)).toBe("src/a.ts");
    expect(parsePathChoice("src/a.ts", known)).toBe("src/a.ts");
    expect(parsePathChoice('```json\n{"path":"src/b/c.ts"}\n```', known)).toBe("src/b/c.ts");
  });

  it("recovers a known path from a chatty reply rather than scoring it wrong", () => {
    expect(parsePathChoice("You should open src/b/c.ts for that.", known)).toBe("src/b/c.ts");
  });

  it("reads an empty answer as a deliberate abstention, not an error", () => {
    expect(parsePathChoice("", known)).toBeNull();
    expect(parsePathChoice('{"path": ""}', known)).toBeNull();
  });

  it("returns undefined — an error, never a wrong answer — for an invented path", () => {
    expect(parsePathChoice("src/does-not-exist.ts", known)).toBeUndefined();
  });

  it("strips a leading ./ so a correct answer is not failed on punctuation", () => {
    expect(parsePathChoice("./src/a.ts", known)).toBe("src/a.ts");
  });
});

describe("the repo-map bench", () => {
  let root: string;
  const cases: RetrievalCase[] = [
    { id: "core", query: "where is the core thing", expected: ["src/core.ts"] },
    { id: "user", query: "where is the wrapper", expected: ["src/user.ts"] },
  ];

  beforeAll(async () => {
    clearRepoMapCache();
    root = await mkdtemp(path.join(tmpdir(), "golem-mapbench-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "src", "core.ts"),
      "export function coreThing(x: string): string {\n  return x;\n}\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "src", "user.ts"),
      "import { coreThing } from './core.js';\nexport function wrapper(): string {\n  return coreThing('a');\n}\n",
      "utf8",
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** An InferenceService that answers from a fixed script — no Ollama needed. */
  function scripted(replies: (context: string) => string): InferenceService {
    return {
      chat: async (_role, messages, _opts?: ChatOptions): Promise<ChatResult> => {
        const user = messages
          .map((m) => String((m as { content?: unknown }).content ?? ""))
          .join("");
        return { text: replies(user), model: "fake-model", role: "drafter" } as ChatResult;
      },
      embed: async () => [],
      capabilities: (): HardwareTier => Tier.PMid,
    };
  }

  it("reports cost without a model — the census half needs no inference", async () => {
    const report = await benchRepoMap({ root, cases });
    expect(report.comparison).toBeUndefined();
    expect(report.filesScanned).toBe(2);
    expect(report.mapTokens).toBeGreaterThan(0);
    expect(report.meanLabelledReadTokens).toBeGreaterThan(0);
    expect(renderRepoMapBench(report)).toContain("No retrieval A/B scored");
  });

  it("scores the map arm above the path arm when only the map carries the answer", async () => {
    // The map arm's context contains signatures; the path arm's does not. The
    // scripted chooser answers correctly only when it can see `coreThing`.
    const report = await benchRepoMap({
      root,
      cases,
      inference: scripted((ctx) =>
        // The map arm's context carries signatures, so this chooser can answer
        // both cases; the path arm sees only paths and always guesses the same.
        ctx.includes("coreThing")
          ? ctx.includes("core thing")
            ? "src/core.ts"
            : "src/user.ts"
          : "src/user.ts",
      ),
    });
    const cmp = report.comparison;
    expect(cmp).toBeDefined();
    expect(cmp?.candidate.accuracy).toBeGreaterThan(cmp?.baseline.accuracy as number);
    expect(cmp?.verdict).toBe("map-helps");
  });

  it("counts an unusable reply as an error, never as a wrong answer", async () => {
    const report = await benchRepoMap({
      root,
      cases,
      inference: scripted(() => "I have no idea, try src/nowhere.ts"),
    });
    const cmp = report.comparison;
    expect(cmp?.baseline.errors).toBe(cases.length);
    expect(cmp?.baseline.correct).toBe(0);
    expect(cmp?.baseline.accuracy).toBeNull();
    expect(cmp?.verdict).toBe("inconclusive");
  });

  it("refuses a verdict when the delta sits inside one case's worth of accuracy", async () => {
    const report = await benchRepoMap({
      root,
      cases,
      inference: scripted(() => "src/core.ts"), // identical in both arms
    });
    expect(report.comparison?.accuracyDelta).toBe(0);
    expect(report.comparison?.verdict).toBe("no-material-change");
  });

  it("names labelled paths that no longer exist instead of scoring them wrong", async () => {
    const report = await benchRepoMap({
      root,
      cases: [{ id: "gone", query: "q", expected: ["src/deleted.ts"] }],
      inference: scripted(() => "src/core.ts"),
    });
    expect(report.missingExpectations).toEqual(["src/deleted.ts"]);
    expect(renderRepoMapBench(report)).toContain("no longer exist");
  });

  it("prints the map's cost beside the accuracy, never one without the other", async () => {
    const report = await benchRepoMap({
      root,
      cases,
      inference: scripted((ctx) =>
        // The map arm's context carries signatures, so this chooser can answer
        // both cases; the path arm sees only paths and always guesses the same.
        ctx.includes("coreThing")
          ? ctx.includes("core thing")
            ? "src/core.ts"
            : "src/user.ts"
          : "src/user.ts",
      ),
    });
    const text = renderRepoMapBench(report);
    expect(text).toContain("context tokens");
    expect(text).toContain("accuracy");
    expect(text).toContain("a labelled file read");
    expect(text).toContain("LOCAL model");
  });
});

describe("renderPathList", () => {
  it("stays within the budget and says how many it dropped", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "golem-pathlist-"));
    try {
      await mkdir(path.join(root, "src"), { recursive: true });
      for (let i = 0; i < 40; i += 1) {
        await writeFile(
          path.join(root, "src", `mod${i}.ts`),
          `export const value${i} = ${i};\n`,
          "utf8",
        );
      }
      clearRepoMapCache();
      const files = await scanRepoFiles(root);
      const text = renderPathList(files, 40);
      expect(text).toContain("more file(s) not listed");
      expect(text.length / 4).toBeLessThan(60);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
