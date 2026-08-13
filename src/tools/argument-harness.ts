/**
 * R8.S1 — the argument-construction harness.
 *
 * Selection accuracy is blind to the failure this measures. A shrunk schema can
 * keep the chooser picking the right tool every time and still stop the model
 * supplying a `ref_id` the tool will accept, because the sentence that said what
 * the parameter meant is the sentence that got dropped. Selection scores that as
 * a clean pass; this scores it as the regression it is.
 *
 * Two rules make the number honest, and both are load-bearing:
 *  - **Grading is always against the ORIGINAL schema** (`reference`), never the
 *    candidate's own. A transform graded by its own relaxed rules gets to lower
 *    its own bar.
 *  - **A model failure is not a wrong answer.** It is counted in `errors` and
 *    excluded from the rates, because "the judge was down" and "the model
 *    answered badly" are different facts (the R4.4 refine lesson: no silent
 *    zeros).
 *
 * Independent of `./selection.ts` on purpose: the two harnesses share a chooser
 * and a catalog type, nothing else. `./compare-catalogs.ts` is what runs them
 * together.
 */

import { stripFence } from "../inference/reply-parsing.js";
import type { InferenceService, Role } from "../interfaces/index.js";
import { type ArgumentCase, type ArgumentOutcome, scoreArguments } from "./arguments.js";
import type { CatalogTool } from "./catalog.js";

const ARG_SYSTEM =
  "You are calling a tool. You are given the tool's name, its description, and its " +
  "JSON Schema of parameters, plus one request. Reply with ONLY a JSON object of the " +
  "arguments to pass. Include every required parameter. Include an optional " +
  "parameter only when the request calls for it. Obey the schema exactly: respect " +
  "types, allowed values, and any stated limits. Do not invent parameters that the " +
  "schema does not declare, and do not wrap the object in any other key.";

/** Parse the model's reply into an arguments object, or undefined if unusable. */
export function parseArguments(text: string): Record<string, unknown> | undefined {
  const trimmed = stripFence(text);
  // A small model sometimes prefixes prose; take the first balanced-looking object.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export interface ArgumentRun {
  readonly model: string | null;
  readonly repeats: number;
  readonly scored: number;
  readonly errors: number;
  /** Cases whose arguments validated against the ORIGINAL schema. */
  readonly valid: number;
  /** Cases that validated AND matched every asserted field. */
  readonly correct: number;
  /** valid / scored, or null when nothing could be scored. */
  readonly validity: number | null;
  /** correct / scored, or null when nothing could be scored. */
  readonly fieldAccuracy: number | null;
  readonly outcomes: readonly ArgumentOutcome[];
}

export interface ArgumentRunOptions {
  readonly inference: InferenceService;
  /** The catalog as the model will see it — shrunk, when scoring a candidate. */
  readonly tools: readonly CatalogTool[];
  /**
   * The catalog to grade against. Always the untransformed one: the question is
   * whether the shrunk schema still elicits arguments the real tool accepts, and
   * grading against the transform's own relaxed rules would let it lower its own bar.
   */
  readonly reference: readonly CatalogTool[];
  readonly cases: readonly ArgumentCase[];
  readonly repeats?: number;
  readonly role?: Role;
}

/**
 * Score argument construction for one catalog.
 *
 * A case naming a tool absent from the catalog is skipped rather than failed — that
 * is a case-set/catalog mismatch (a renamed tool), not a model error, and scoring it
 * as wrong would quietly punish both catalogs equally and hide the rename.
 */
export async function runArgumentHarness(opts: ArgumentRunOptions): Promise<ArgumentRun> {
  const repeats = Math.max(1, opts.repeats ?? 1);
  const role = opts.role ?? "classifier";
  const shown = new Map(opts.tools.map((t) => [t.name, t]));
  const reference = new Map(opts.reference.map((t) => [t.name, t]));
  const outcomes: ArgumentOutcome[] = [];
  let model: string | null = null;

  for (let pass = 0; pass < repeats; pass++) {
    for (const testCase of opts.cases) {
      const tool = shown.get(testCase.tool);
      const ref = reference.get(testCase.tool);
      if (tool === undefined || ref === undefined) continue;
      try {
        const result = await opts.inference.chat(
          role,
          [
            { role: "system", content: ARG_SYSTEM },
            {
              role: "user",
              content:
                `Tool: ${tool.name}\nDescription: ${tool.description}\n` +
                `Parameters (JSON Schema): ${JSON.stringify(tool.schema)}\n\n` +
                `Request: ${testCase.prompt}`,
            },
          ],
          { temperature: 0 },
        );
        if (result.model !== null) model = result.model;
        const args = parseArguments(result.text);
        if (args === undefined) {
          outcomes.push({
            id: testCase.id,
            tool: testCase.tool,
            valid: false,
            fieldsCorrect: false,
            violations: [],
            wrongFields: [],
            error: `unparseable arguments: ${result.text.slice(0, 80)}`,
          });
          continue;
        }
        outcomes.push(scoreArguments(testCase, ref.schema, args));
      } catch (err) {
        outcomes.push({
          id: testCase.id,
          tool: testCase.tool,
          valid: false,
          fieldsCorrect: false,
          violations: [],
          wrongFields: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const scoredOutcomes = outcomes.filter((o) => o.error === undefined);
  const valid = scoredOutcomes.filter((o) => o.valid).length;
  const correct = scoredOutcomes.filter((o) => o.valid && o.fieldsCorrect).length;
  return {
    model,
    repeats,
    scored: scoredOutcomes.length,
    errors: outcomes.length - scoredOutcomes.length,
    valid,
    correct,
    validity: scoredOutcomes.length === 0 ? null : valid / scoredOutcomes.length,
    fieldAccuracy: scoredOutcomes.length === 0 ? null : correct / scoredOutcomes.length,
    outcomes,
  };
}
