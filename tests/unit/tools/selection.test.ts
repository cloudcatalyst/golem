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
  parseArguments,
  parseChoice,
  runArgumentHarness,
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
  // The same rule applies to the schema half: a fixture whose `schemaTokens`
  // disagrees with its `schema` would make a schema transform's saving fictional.
  const schema = {
    type: "object",
    properties: { q: { description: "x".repeat(schemaTokens * 4) } },
  };
  return {
    name,
    description,
    descriptionTokens,
    definitionTokens: descriptionTokens + estimateTokens(JSON.stringify(schema)),
    schema,
    schemaTokens: estimateTokens(JSON.stringify(schema)),
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

/**
 * R8.S1 — the argument harness inside the comparison.
 *
 * The property under test is the *veto*: a schema transform that keeps selection
 * perfect and breaks argument construction must come out REGRESSED. §89's harness
 * would have called that same transform a clean pass, because it never showed the
 * chooser a schema.
 */
describe("runArgumentHarness", () => {
  const ARG_TOOLS: readonly CatalogTool[] = [
    {
      name: "level",
      description: "Set the slider.",
      descriptionTokens: 4,
      definitionTokens: 60,
      schema: {
        type: "object",
        properties: { level: { type: "integer", minimum: 0, maximum: 5 } },
        required: ["level"],
        additionalProperties: false,
      },
      schemaTokens: 40,
    },
  ];
  const argCases = [{ id: "a1", tool: "level", prompt: "set it to 2", expect: { level: 2 } }];

  it("scores valid, matching arguments", async () => {
    const run = await runArgumentHarness({
      inference: scriptedInference(['{"level":2}']),
      tools: ARG_TOOLS,
      reference: ARG_TOOLS,
      cases: argCases,
    });
    expect(run.scored).toBe(1);
    expect(run.valid).toBe(1);
    expect(run.correct).toBe(1);
    expect(run.validity).toBe(1);
    expect(run.fieldAccuracy).toBe(1);
  });

  it("separates an invalid answer from a valid-but-wrong one", async () => {
    const invalid = await runArgumentHarness({
      inference: scriptedInference(['{"level":9}']),
      tools: ARG_TOOLS,
      reference: ARG_TOOLS,
      cases: argCases,
    });
    expect(invalid.validity).toBe(0);

    const wrong = await runArgumentHarness({
      inference: scriptedInference(['{"level":3}']),
      tools: ARG_TOOLS,
      reference: ARG_TOOLS,
      cases: argCases,
    });
    expect(wrong.validity).toBe(1);
    expect(wrong.fieldAccuracy).toBe(0);
  });

  it("excludes an unparseable reply rather than scoring it wrong", async () => {
    const run = await runArgumentHarness({
      inference: scriptedInference(["I would call level with 2"]),
      tools: ARG_TOOLS,
      reference: ARG_TOOLS,
      cases: argCases,
    });
    expect(run.errors).toBe(1);
    expect(run.scored).toBe(0);
    expect(run.validity).toBeNull();
  });

  it("excludes a dead model rather than reporting 0%", async () => {
    const run = await runArgumentHarness({
      inference: failingInference("ollama unreachable"),
      tools: ARG_TOOLS,
      reference: ARG_TOOLS,
      cases: argCases,
    });
    expect(run.errors).toBe(1);
    expect(run.validity).toBeNull();
  });

  it("skips a case naming a tool the catalog does not have", async () => {
    const run = await runArgumentHarness({
      inference: scriptedInference(['{"level":2}']),
      tools: ARG_TOOLS,
      reference: ARG_TOOLS,
      cases: [{ id: "gone", tool: "renamed_away", prompt: "x" }],
    });
    // A rename is a case-set/catalog mismatch, not a model error — scoring it as
    // wrong would punish both catalogs equally and hide the rename.
    expect(run.scored).toBe(0);
    expect(run.errors).toBe(0);
    expect(run.outcomes).toHaveLength(0);
  });

  it("grades the candidate against the reference schema, not its own", async () => {
    // `level: 9` is valid under the relaxed candidate schema and invalid under the
    // original. The run must report invalid.
    const relaxed = shrinkCatalog(ARG_TOOLS, "schema-validation");
    const run = await runArgumentHarness({
      inference: scriptedInference(['{"level":9}']),
      tools: relaxed,
      reference: ARG_TOOLS,
      cases: argCases,
    });
    expect(run.validity).toBe(0);
  });
});

describe("parseArguments", () => {
  it("reads a plain object and one wrapped in a fence", () => {
    expect(parseArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseArguments('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("recovers an object a small model buried in prose", () => {
    expect(parseArguments('Sure! Here you go: {"a":1} — let me know.')).toEqual({ a: 1 });
  });

  it("returns undefined rather than guessing", () => {
    expect(parseArguments("no object here")).toBeUndefined();
    expect(parseArguments("[1,2]")).toBeUndefined();
    expect(parseArguments("{not json}")).toBeUndefined();
  });
});

describe("compareCatalogs — schema transforms", () => {
  const cases = Array.from({ length: 10 }, (_, i) => ({
    id: `c${i}`,
    prompt: "set the slider",
    expected: "search" as string | null,
  }));
  const argCases = Array.from({ length: 10 }, (_, i) => ({
    id: `a${i}`,
    tool: "search",
    prompt: "set it",
    expect: { level: 2 },
  }));

  /** Chooser that answers selection with `search` and arguments with `level`. */
  function twoPhase(argReply: string): InferenceService {
    return {
      chat: (_role: Role, messages): Promise<ChatResult> => {
        const asked = messages.map((m) => m.content).join("\n");
        const text = asked.includes("Reply with ONLY a JSON object") ? argReply : "search";
        return Promise.resolve({
          text,
          model: "fake-model",
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

  const SCHEMA_TOOLS: readonly CatalogTool[] = [
    {
      name: "search",
      description: "Search.",
      descriptionTokens: 2,
      definitionTokens: 60,
      schema: {
        type: "object",
        properties: { level: { type: "integer", minimum: 0, maximum: 5 } },
        required: ["level"],
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#",
      },
      schemaTokens: 40,
    },
  ];

  it("measures the schema half, not the description half", async () => {
    const result = await compareCatalogs({
      inference: twoPhase('{"level":2}'),
      baseline: SCHEMA_TOOLS,
      candidate: shrinkCatalog(SCHEMA_TOOLS, "schema-descriptions"),
      cases,
      render: "full",
      measuring: "schemas",
      argumentCases: argCases,
    });
    expect(result.measuring).toBe("schemas");
    expect(result.render).toBe("full");
    // A description-measuring comparison would have reported 0 saved here.
    expect(result.tokensSaved).toBeGreaterThan(0);
  });

  it("vetoes on an argument regression even when selection is untouched", async () => {
    const baselineRun = await compareCatalogs({
      inference: twoPhase('{"level":2}'),
      baseline: SCHEMA_TOOLS,
      candidate: shrinkCatalog(SCHEMA_TOOLS, "schema-meta"),
      cases,
      render: "full",
      measuring: "schemas",
      argumentCases: argCases,
    });
    expect(baselineRun.verdict).toBe("no-material-change");

    // Same selection behaviour, arguments now out of range.
    const regressed = await compareCatalogs({
      inference: {
        chat: (_role: Role, messages): Promise<ChatResult> => {
          const asked = messages.map((m) => m.content).join("\n");
          const isArgs = asked.includes("Reply with ONLY a JSON object");
          // Only the candidate run sees a schema without `maximum`; answer badly there.
          const text = isArgs
            ? asked.includes("maximum")
              ? '{"level":2}'
              : '{"level":9}'
            : "search";
          return Promise.resolve({
            text,
            model: "fake-model",
            role: "classifier",
            promptTokens: 0,
            completionTokens: 0,
            finishReason: "stop",
          });
        },
        embed: (): Promise<Vector[]> => Promise.resolve([]),
        capabilities: (): HardwareTier => HardwareTier.PMid,
      },
      baseline: SCHEMA_TOOLS,
      candidate: shrinkCatalog(SCHEMA_TOOLS, "schema-validation"),
      cases,
      render: "full",
      measuring: "schemas",
      argumentCases: argCases,
    });
    expect(regressed.accuracyDelta).toBe(0);
    expect(regressed.arguments?.validityDelta).toBeLessThan(0);
    expect(regressed.verdict).toBe("regressed");
    expect(regressed.notes.some((n) => n.includes("selection-only gate cannot see"))).toBe(true);
  });

  it("says so loudly when a schema transform was scored without an argument gate", async () => {
    const result = await compareCatalogs({
      inference: twoPhase('{"level":2}'),
      baseline: SCHEMA_TOOLS,
      candidate: shrinkCatalog(SCHEMA_TOOLS, "schema-descriptions"),
      cases,
      measuring: "schemas",
    });
    expect(result.arguments).toBeUndefined();
    expect(result.notes.some((n) => n.includes("cannot see schemas"))).toBe(true);
    expect(result.notes.some((n) => n.includes("descriptions only"))).toBe(true);
  });

  it("defaults to the description-only shape §89 used", async () => {
    const result = await compareCatalogs({
      inference: scriptedInference(['{"tool":"search"}']),
      baseline: TOOLS,
      candidate: shrinkCatalog(TOOLS, "first-sentence"),
      cases,
    });
    expect(result.render).toBe("description");
    expect(result.measuring).toBe("descriptions");
    expect(result.arguments).toBeUndefined();
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

  it("leaves the schema byte-identical in a description mode", () => {
    const [after] = shrinkCatalog(TOOLS, "first-sentence");
    expect(JSON.stringify(after?.schema)).toBe(JSON.stringify(TOOLS[0]?.schema));
    expect(after?.schemaTokens).toBe(TOOLS[0]?.schemaTokens);
  });
});

/**
 * R8.S1 — the schema transforms.
 *
 * The property that matters most is the one a careless implementation would break:
 * the structural keys a tool cannot run without (`type`, `properties`, `required`,
 * `enum`, `items`) must survive **every** mode. A "shrinker" that dropped `required`
 * would be a bug the harness would then have to discover the expensive way.
 */
describe("shrinkCatalog — schema modes", () => {
  const REAL: CatalogTool = {
    name: "level",
    description: "Set the slider.",
    descriptionTokens: 4,
    definitionTokens: 100,
    schema: {
      type: "object",
      properties: {
        level: { type: "integer", minimum: 0, maximum: 5, description: "Slider level 0-5" },
        tags: { type: "array", items: { type: "string", minLength: 1 } },
        kind: { type: "string", enum: ["a", "b"], description: "Which kind" },
      },
      required: ["level"],
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    },
    schemaTokens: 80,
  };

  function shrunk(mode: "schema-meta" | "schema-validation" | "schema-descriptions"): CatalogTool {
    const [only] = shrinkCatalog([REAL], mode);
    if (only === undefined) throw new Error("shrinkCatalog dropped a tool");
    return only;
  }

  it.each([
    "schema-meta",
    "schema-validation",
    "schema-descriptions",
  ] as const)("%s keeps every structural key", (mode) => {
    const json = JSON.stringify(shrunk(mode).schema);
    expect(json).toContain('"type"');
    expect(json).toContain('"properties"');
    expect(json).toContain('"required"');
    expect(json).toContain('"enum"');
    expect(json).toContain('"items"');
    expect(json).toContain("level");
  });

  it("schema-meta drops only the draft URI", () => {
    const json = JSON.stringify(shrunk("schema-meta").schema);
    expect(json).not.toContain("$schema");
    // Everything a model reads survives — this is the one mode expected to be free.
    expect(json).toContain("minimum");
    expect(json).toContain("Slider level 0-5");
    expect(json).toContain("additionalProperties");
  });

  it("schema-validation additionally drops bounds and additionalProperties", () => {
    const json = JSON.stringify(shrunk("schema-validation").schema);
    expect(json).not.toContain("$schema");
    expect(json).not.toContain("minimum");
    expect(json).not.toContain("maximum");
    expect(json).not.toContain("minLength");
    expect(json).not.toContain("additionalProperties");
    // Descriptions still there: this is the middle rung, not the bottom one.
    expect(json).toContain("Slider level 0-5");
  });

  it("schema-descriptions additionally drops every per-property description", () => {
    const json = JSON.stringify(shrunk("schema-descriptions").schema);
    expect(json).not.toContain("Slider level 0-5");
    expect(json).not.toContain("Which kind");
    expect(json).not.toContain("description");
  });

  it("strips nested keys, not just top-level ones", () => {
    // `minLength` here lives under properties.tags.items — a one-level strip would
    // miss it and understate the transform.
    expect(JSON.stringify(shrunk("schema-validation").schema)).not.toContain("minLength");
  });

  it("is cumulative, so each mode saves at least as much as the one above", () => {
    const meta = shrunk("schema-meta").schemaTokens;
    const validation = shrunk("schema-validation").schemaTokens;
    const descriptions = shrunk("schema-descriptions").schemaTokens;
    expect(meta).toBeLessThan(REAL.schemaTokens);
    expect(validation).toBeLessThanOrEqual(meta);
    expect(descriptions).toBeLessThanOrEqual(validation);
  });

  it("recomputes definition tokens as the schema delta only, leaving the prose alone", () => {
    const after = shrunk("schema-descriptions");
    expect(after.description).toBe(REAL.description);
    expect(after.descriptionTokens).toBe(REAL.descriptionTokens);
    expect(after.definitionTokens).toBe(
      REAL.definitionTokens - REAL.schemaTokens + after.schemaTokens,
    );
  });
});
