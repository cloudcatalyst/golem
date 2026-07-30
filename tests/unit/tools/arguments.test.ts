/**
 * R8.S1 — the argument-construction harness's own correctness.
 *
 * This is a measuring instrument, so a miscalibration here is worse than a bug in a
 * feature: it would produce a confident verdict on whether Golem may shrink its tool
 * schemas. Two properties carry the whole result and are pinned hardest:
 *
 *  - grading happens against the **original** schema, never the shrunk one, so a
 *    transform cannot pass by relaxing the rules it is judged against;
 *  - a violation is *reported*, not swallowed — "invalid" without a reason would make
 *    a regression impossible to diagnose.
 */

import { describe, expect, it } from "vitest";
import { scoreArguments, validateAgainstSchema } from "../../../src/tools/index.js";

const LEVEL_SCHEMA = {
  type: "object",
  properties: {
    level: { type: "integer", minimum: 0, maximum: 5, description: "Slider level 0-5" },
  },
  required: ["level"],
  additionalProperties: false,
  $schema: "http://json-schema.org/draft-07/schema#",
};

describe("validateAgainstSchema", () => {
  it("accepts a conforming object", () => {
    expect(validateAgainstSchema(LEVEL_SCHEMA, { level: 2 })).toEqual([]);
  });

  it("names a missing required field", () => {
    const v = validateAgainstSchema(LEVEL_SCHEMA, {});
    expect(v).toHaveLength(1);
    expect(v[0]?.path).toBe("level");
    expect(v[0]?.problem).toContain("required");
  });

  it("catches an out-of-range number — the bound `schema-validation` removes", () => {
    const v = validateAgainstSchema(LEVEL_SCHEMA, { level: 9 });
    expect(v).toHaveLength(1);
    expect(v[0]?.problem).toContain("above maximum 5");
    expect(validateAgainstSchema(LEVEL_SCHEMA, { level: -1 })[0]?.problem).toContain(
      "below minimum 0",
    );
  });

  it("catches a wrong type and stops descending into it", () => {
    const v = validateAgainstSchema(LEVEL_SCHEMA, { level: "two" });
    expect(v).toHaveLength(1);
    expect(v[0]?.problem).toContain("expected integer");
  });

  it("treats an integer as a valid number but not the reverse", () => {
    expect(validateAgainstSchema({ type: "number" }, 2)).toEqual([]);
    expect(validateAgainstSchema({ type: "integer" }, 2.5)).toHaveLength(1);
  });

  it("catches an invented parameter only when additionalProperties is false", () => {
    expect(validateAgainstSchema(LEVEL_SCHEMA, { level: 1, mode: "fast" })).toHaveLength(1);
    const open = { ...LEVEL_SCHEMA, additionalProperties: true };
    expect(validateAgainstSchema(open, { level: 1, mode: "fast" })).toEqual([]);
  });

  it("enforces an enum — wiki_upsert's `type` is the case that needs it", () => {
    const schema = { type: "string", enum: ["concept", "debrief"] };
    expect(validateAgainstSchema(schema, "concept")).toEqual([]);
    expect(validateAgainstSchema(schema, "note")[0]?.problem).toContain("allowed values");
  });

  it("enforces string length and exclusive bounds", () => {
    expect(validateAgainstSchema({ type: "string", minLength: 1 }, "")).toHaveLength(1);
    expect(validateAgainstSchema({ type: "integer", exclusiveMinimum: 0 }, 0)).toHaveLength(1);
    expect(validateAgainstSchema({ type: "integer", exclusiveMinimum: 0 }, 1)).toEqual([]);
  });

  it("validates array items", () => {
    const schema = { type: "array", items: { type: "string" } };
    expect(validateAgainstSchema(schema, ["a", "b"])).toEqual([]);
    const v = validateAgainstSchema(schema, ["a", 3]);
    expect(v).toHaveLength(1);
    expect(v[0]?.path).toBe("1");
  });

  it("reports every violation, not just the first", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "integer", maximum: 1 }, b: { type: "string" } },
      required: ["c"],
    };
    expect(validateAgainstSchema(schema, { a: 9, b: 3 })).toHaveLength(3);
  });

  it("is tolerant of a non-schema and of an empty schema", () => {
    expect(validateAgainstSchema(null, { anything: true })).toEqual([]);
    expect(validateAgainstSchema({}, { anything: true })).toEqual([]);
  });
});

describe("scoreArguments", () => {
  const testCase = { id: "c", tool: "level", prompt: "set it to 2", expect: { level: 2 } };

  it("scores conforming, matching arguments as correct", () => {
    const out = scoreArguments(testCase, LEVEL_SCHEMA, { level: 2 });
    expect(out.valid).toBe(true);
    expect(out.fieldsCorrect).toBe(true);
    expect(out.wrongFields).toEqual([]);
  });

  it("separates 'invalid' from 'valid but wrong value'", () => {
    const wrongValue = scoreArguments(testCase, LEVEL_SCHEMA, { level: 3 });
    expect(wrongValue.valid).toBe(true);
    expect(wrongValue.fieldsCorrect).toBe(false);
    expect(wrongValue.wrongFields).toEqual(["level"]);

    const invalid = scoreArguments(testCase, LEVEL_SCHEMA, { level: 9 });
    expect(invalid.valid).toBe(false);
    expect(invalid.violations).toHaveLength(1);
  });

  it("grades against the schema it is given — the ORIGINAL, not a relaxed one", () => {
    // This is the whole anti-self-deception property: a `schema-validation`
    // candidate drops `maximum`, so grading against the candidate's own schema
    // would score `level: 9` as valid and the transform would pass by lowering
    // its own bar.
    const relaxed = { type: "object", properties: { level: { type: "integer" } } };
    expect(scoreArguments(testCase, relaxed, { level: 9 }).valid).toBe(true);
    expect(scoreArguments(testCase, LEVEL_SCHEMA, { level: 9 }).valid).toBe(false);
  });

  it("compares fields loosely so a stringified number is not counted twice", () => {
    // The type question is already covered by validation; double-counting it would
    // exaggerate the delta.
    const out = scoreArguments(testCase, { type: "object" }, { level: "2" });
    expect(out.fieldsCorrect).toBe(true);
  });

  it("counts a missing expected field as wrong", () => {
    const out = scoreArguments(testCase, { type: "object" }, {});
    expect(out.fieldsCorrect).toBe(false);
    expect(out.wrongFields).toEqual(["level"]);
  });

  it("treats a case with no expectations as field-correct whenever it is valid", () => {
    const bare = { id: "c", tool: "search", prompt: "search for x" };
    expect(scoreArguments(bare, { type: "object" }, { query: "x" }).fieldsCorrect).toBe(true);
  });

  it("does not crash on non-object arguments", () => {
    const out = scoreArguments(testCase, LEVEL_SCHEMA, "not an object");
    expect(out.valid).toBe(false);
    expect(out.fieldsCorrect).toBe(false);
  });
});
