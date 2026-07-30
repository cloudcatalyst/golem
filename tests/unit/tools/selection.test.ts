/**
 * Workstream B — the tool-selection harness's own correctness.
 *
 * The harness is a measuring instrument, so its failure modes are worse than a
 * feature's: a miscalibrated one produces confident numbers that are wrong. These
 * tests pin the three properties the numbers depend on — abstentions are read as
 * abstentions, chooser failures are excluded rather than scored, and the verdict
 * refuses to call noise a result.
 */

import { describe, expect, it } from "vitest";
import { estimateTokens } from "../../../src/compression/tokens.js";
import type {
  ChatOptions,
  ChatResult,
  InferenceService,
  Role,
  Vector,
} from "../../../src/interfaces/index.js";
import { HardwareTier } from "../../../src/interfaces/index.js";
import type { CatalogTool } from "../../../src/tools/index.js";
import {
  compareCatalogs,
  parseChoice,
  runSelectionHarness,
  shrinkCatalog,
} from "../../../src/tools/index.js";

const NAMES = new Set(["search", "coder", "expand"]);

/**
 * Token counts must be computed, not invented: a fixture whose
 * `descriptionTokens` disagrees with `estimateTokens(description)` makes even the
 * lossless transform look like it saves tokens, because `shrinkCatalog`
 * recomputes from the string. (That is exactly how this fixture failed first.)
 */
function tool(name: string, description: string, schemaTokens: number): CatalogTool {
  const descriptionTokens = estimateTokens(description);
  return {
    name,
    description,
    descriptionTokens,
    definitionTokens: descriptionTokens + schemaTokens,
  };
}

const TOOLS: readonly CatalogTool[] = [
  tool("search", "Semantic search over the local index. Use it before fetching the web.", 40),
  tool("coder", "Draft code with a local model. Review the draft yourself afterwards.", 37),
];

/** Chooser that replays scripted replies, one per call. */
function scriptedInference(replies: readonly string[], model = "fake-model"): InferenceService {
  let i = 0;
  return {
    chat: (_role: Role, _messages, _opts?: ChatOptions): Promise<ChatResult> => {
      const text = replies[i % replies.length] ?? "";
      i++;
      return Promise.resolve({
        text,
        model,
        role: "classifier",
        promptTokens: 0,
        completionTokens: 0,
        finishReason: "stop",
      });
    },
    embed: (): Promise<Vector[]> => Promise.resolve([]),
    capabilities: (): HardwareTier => HardwareTier.PMid,
  };
}

function failingInference(message: string): InferenceService {
  return {
    chat: () => Promise.reject(new Error(message)),
    embed: (): Promise<Vector[]> => Promise.resolve([]),
    capabilities: (): HardwareTier => HardwareTier.PMid,
  };
}

describe("parseChoice", () => {
  it("reads a schema-shaped object", () => {
    expect(parseChoice('{"tool":"search"}', NAMES)).toBe("search");
  });

  it("reads a bare tool name (small models ignore the schema)", () => {
    expect(parseChoice("coder", NAMES)).toBe("coder");
    expect(parseChoice('"coder"', NAMES)).toBe("coder");
    expect(parseChoice('```json\n{"tool":"expand"}\n```', NAMES)).toBe("expand");
  });

  it.each([
    ['""', "a JSON empty string"],
    ["", "nothing at all"],
    ["none", "the word none"],
    ["empty string", "a description of emptiness"],
    ["```\n```", "an empty fence"],
    ['{"tool":""}', "an empty schema field"],
    ["N/A", "n/a"],
  ])("treats %j as a deliberate abstention (%s)", (reply) => {
    // Regression: `JSON.parse('""')` yields a bare string, which an object-only
    // branch dropped — so 4 of 5 "errors" in the first real run were actually
    // correct abstentions being thrown away.
    expect(parseChoice(reply, NAMES)).toBeNull();
  });

  it("rejects an invented tool name rather than scoring it", () => {
    expect(parseChoice("golem_search", NAMES)).toBeUndefined();
    expect(parseChoice("I think you should use search for this", NAMES)).toBeUndefined();
  });
});

describe("runSelectionHarness", () => {
  const cases = [
    { id: "a", prompt: "find the redaction stage", expected: "search" },
    { id: "b", prompt: "thanks!", expected: null },
  ] as const;

  it("scores correct choices and abstentions", async () => {
    const run = await runSelectionHarness({
      inference: scriptedInference(['{"tool":"search"}', '{"tool":""}']),
      tools: TOOLS,
      cases,
    });
    expect(run.scored).toBe(2);
    expect(run.correct).toBe(2);
    expect(run.accuracy).toBe(1);
    expect(run.errors).toBe(0);
    expect(run.falsePositives).toBe(0);
    expect(run.abstentions).toBe(0);
    expect(run.model).toBe("fake-model");
  });

  it("counts a false positive and an abstention separately", async () => {
    // Reply order: case a gets "" (abstained where a tool applies), case b gets
    // "coder" (chose a tool where none applies).
    const run = await runSelectionHarness({
      inference: scriptedInference(['""', "coder"]),
      tools: TOOLS,
      cases,
    });
    expect(run.correct).toBe(0);
    expect(run.abstentions).toBe(1);
    expect(run.falsePositives).toBe(1);
    expect(run.errors).toBe(0);
  });

  it("excludes chooser failures from scoring instead of counting them wrong", async () => {
    const run = await runSelectionHarness({
      inference: failingInference('no backend available for role "classifier"'),
      tools: TOOLS,
      cases,
    });
    expect(run.errors).toBe(2);
    expect(run.scored).toBe(0);
    // The R4.4 refine lesson: a dead judge must not read as a 0% score.
    expect(run.accuracy).toBeNull();
    expect(run.outcomes.every((o) => o.error !== undefined)).toBe(true);
  });

  it("pools repeats", async () => {
    const run = await runSelectionHarness({
      inference: scriptedInference(['{"tool":"search"}', '{"tool":""}']),
      tools: TOOLS,
      cases,
      repeats: 3,
    });
    expect(run.repeats).toBe(3);
    expect(run.scored).toBe(6);
    expect(run.outcomes).toHaveLength(6);
  });
});

describe("compareCatalogs", () => {
  const cases = Array.from({ length: 10 }, (_, i) => ({
    id: `c${i}`,
    prompt: "find something",
    expected: "search" as string | null,
  }));

  it("reports no-material-change when the delta is under one case", async () => {
    const result = await compareCatalogs({
      inference: scriptedInference(['{"tool":"search"}']),
      baseline: TOOLS,
      candidate: shrinkCatalog(TOOLS, "first-sentence"),
      cases,
    });
    expect(result.accuracyDelta).toBe(0);
    expect(result.verdict).toBe("no-material-change");
    // first-sentence drops the second sentence of both descriptions.
    expect(result.tokensSaved).toBeGreaterThan(0);
  });

  it("is inconclusive when the chooser errored, however clean the delta looks", async () => {
    const result = await compareCatalogs({
      inference: failingInference("ollama unreachable"),
      baseline: TOOLS,
      candidate: shrinkCatalog(TOOLS, "whitespace"),
      cases,
    });
    expect(result.verdict).toBe("inconclusive");
    expect(result.accuracyDelta).toBeNull();
  });

  it("warns when the candidate is not actually smaller", async () => {
    const result = await compareCatalogs({
      inference: scriptedInference(['{"tool":"search"}']),
      baseline: TOOLS,
      candidate: shrinkCatalog(TOOLS, "whitespace"),
      cases,
    });
    // These descriptions have no redundant whitespace, so the control transform
    // saves literally nothing — the report must say so rather than imply a win.
    expect(result.tokensSaved).toBe(0);
    expect(result.notes.some((n) => n.includes("not smaller"))).toBe(true);
  });
});

describe("shrinkCatalog", () => {
  /** Shrink one description and return the result — keeps these tests index-free. */
  function shrinkOne(description: string, mode: "whitespace" | "first-sentence"): CatalogTool {
    const [only] = shrinkCatalog([tool("t", description, 10)], mode);
    if (only === undefined) throw new Error("shrinkCatalog dropped a tool");
    return only;
  }

  it("whitespace mode preserves every word", () => {
    expect(shrinkOne("Two   spaces\n\nand a newline.", "whitespace").description).toBe(
      "Two spaces and a newline.",
    );
  });

  it("first-sentence mode keeps only the opening sentence", () => {
    const shrunk = shrinkCatalog(TOOLS, "first-sentence");
    expect(shrunk.map((t) => t.description)).toStrictEqual([
      "Semantic search over the local index.",
      "Draft code with a local model.",
    ]);
  });

  it("does not split on an abbreviation or a marker mid-sentence", () => {
    // The split must land on the first real sentence boundary followed by a
    // capital, not on `e.g.`.
    const shrunk = shrinkOne(
      "Retrieve content behind `hash=<id>`. e.g. a CCR ref. Use when needed.",
      "first-sentence",
    );
    expect(shrunk.description).toBe("Retrieve content behind `hash=<id>`. e.g. a CCR ref.");
  });

  it("recomputes definition tokens as description delta only", () => {
    const before = tool("t", "One sentence. And a second one that will be dropped.", 10);
    const [after] = shrinkCatalog([before], "first-sentence");
    if (after === undefined) throw new Error("shrinkCatalog dropped a tool");
    expect(after.definitionTokens).toBe(
      before.definitionTokens - before.descriptionTokens + after.descriptionTokens,
    );
    expect(after.descriptionTokens).toBeLessThan(before.descriptionTokens);
  });
});
