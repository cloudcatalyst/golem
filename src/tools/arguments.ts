/**
 * R8.S1 — the argument-construction harness.
 *
 * §89 built a tool-*selection* harness and used it to reject the prose shrinker.
 * Pointing that same harness at a schema transform would be self-deception: the
 * selection prompt renders `- name: description` and never shows the schema at all,
 * so a schema rewrite scores a perfect zero delta on it **by construction**. A
 * clean result there would mean the harness was blind, not that the transform was
 * safe.
 *
 * The failure mode a schema shrink actually causes is one step later: the model
 * picks the right tool and then **fills it in wrongly** — omits a required field,
 * passes a level of 9 because nothing said 0–5, or puts "2pm tomorrow" where an
 * ISO-8601 string was wanted. So this module scores that instead:
 *
 *  1. Show the model one tool's real schema and a request.
 *  2. Take the arguments it produces.
 *  3. Validate them against the **original** schema — never the shrunk one. The
 *     question is whether the shrunk schema still elicits arguments the real tool
 *     would accept, and grading against the transform's own relaxed rules would
 *     let a transform pass by lowering the bar it is judged on.
 *  4. Check the fields the prompt determines unambiguously.
 *
 * The validator is deliberately a small hand-rolled subset rather than a zod or
 * ajv construction: it validates *JSON Schema as the MCP server emits it*, which
 * is a fixed, narrow dialect (type/properties/required/enum/bounds/items), and a
 * general-purpose validator would add a dependency and a supply-chain question
 * (R8.10) for no extra coverage.
 */

/** One violation, named so a report can say *what* broke rather than just "invalid". */
export interface SchemaViolation {
  /** Dotted path to the offending value; empty string for the root object. */
  readonly path: string;
  readonly problem: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeMatches(expected: string, value: unknown): boolean {
  const actual = typeOf(value);
  if (expected === actual) return true;
  // An integer is a valid number; a number is not a valid integer.
  return expected === "number" && actual === "integer";
}

function join(prefix: string, key: string): string {
  return prefix === "" ? key : `${prefix}.${key}`;
}

/**
 * Validate `value` against the JSON-Schema subset the MCP server emits.
 *
 * Returns every violation rather than the first, because "missing `task` AND level
 * out of range" and "missing `task`" are different degrees of wrong and a shrinker
 * comparison wants the count.
 */
export function validateAgainstSchema(
  schema: unknown,
  value: unknown,
  path = "",
): readonly SchemaViolation[] {
  if (!isRecord(schema)) return [];
  const out: SchemaViolation[] = [];

  const expectedType = schema.type;
  if (typeof expectedType === "string" && !typeMatches(expectedType, value)) {
    out.push({ path, problem: `expected ${expectedType}, got ${typeOf(value)}` });
    // Every further check assumes the type held, so stop here for this node.
    return out;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
    out.push({ path, problem: `not one of the ${schema.enum.length} allowed values` });
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      out.push({ path, problem: `below minimum ${schema.minimum}` });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      out.push({ path, problem: `above maximum ${schema.maximum}` });
    }
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
      out.push({ path, problem: `not greater than ${schema.exclusiveMinimum}` });
    }
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
      out.push({ path, problem: `not less than ${schema.exclusiveMaximum}` });
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      out.push({ path, problem: `shorter than minLength ${schema.minLength}` });
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      out.push({ path, problem: `longer than maxLength ${schema.maxLength}` });
    }
  }

  if (Array.isArray(value) && isRecord(schema.items)) {
    for (const [index, item] of value.entries()) {
      out.push(...validateAgainstSchema(schema.items, item, join(path, String(index))));
    }
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && value[key] === undefined) {
          out.push({ path: join(path, key), problem: "required but missing" });
        }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key];
      if (childSchema === undefined) {
        if (schema.additionalProperties === false) {
          out.push({ path: join(path, key), problem: "not a declared parameter" });
        }
        continue;
      }
      // An explicitly-absent optional value is not a violation.
      if (child === undefined) continue;
      out.push(...validateAgainstSchema(childSchema, child, join(path, key)));
    }
  }

  return out;
}

/** A labelled argument-construction case. */
export interface ArgumentCase {
  readonly id: string;
  /** Tool whose schema the model is asked to fill. */
  readonly tool: string;
  readonly prompt: string;
  /**
   * Field values the prompt determines unambiguously.
   *
   * Kept small on purpose: only values a careful reader could not disagree about
   * (the hex id in the prompt, the level number, the boolean the request spells
   * out). Anything requiring judgement is left out, because the labels are ours and
   * an over-specified expectation measures our taste rather than the schema.
   */
  readonly expect?: Readonly<Record<string, string | number | boolean>>;
}

/** How one argument case resolved. */
export interface ArgumentOutcome {
  readonly id: string;
  readonly tool: string;
  /** Passed schema validation against the ORIGINAL schema. */
  readonly valid: boolean;
  /** Every expected field matched (only meaningful when `valid`). */
  readonly fieldsCorrect: boolean;
  readonly violations: readonly SchemaViolation[];
  /** Fields that were expected and came back different or missing. */
  readonly wrongFields: readonly string[];
  readonly error?: string;
}

/**
 * Compare produced arguments against a case's expectations.
 *
 * Field comparison is by loose string equality (`String(actual) === String(want)`)
 * so a model answering `2` for an integer field and one answering `"2"` are not
 * scored differently — the transport-level type question is already covered by
 * schema validation, and double-counting it would exaggerate any delta.
 */
export function scoreArguments(
  testCase: ArgumentCase,
  originalSchema: unknown,
  args: unknown,
): ArgumentOutcome {
  const violations = validateAgainstSchema(originalSchema, args);
  const wrongFields: string[] = [];
  const record = isRecord(args) ? args : {};
  for (const [key, want] of Object.entries(testCase.expect ?? {})) {
    const actual = record[key];
    if (actual === undefined || String(actual) !== String(want)) wrongFields.push(key);
  }
  return {
    id: testCase.id,
    tool: testCase.tool,
    valid: violations.length === 0,
    fieldsCorrect: wrongFields.length === 0,
    violations,
    wrongFields,
  };
}
