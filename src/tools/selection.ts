/**
 * Workstream B — the tool-selection-accuracy harness.
 *
 * §88 parked the tools-block shrinker on one blocker: shortening a tool
 * description changes *instructions the model reads to decide whether to call the
 * tool*, and there was no way to measure whether selection behaviour survived.
 * This is that measurement.
 *
 * The shape is deliberately an **A/B**, not an absolute score. Absolute accuracy
 * against hand-written labels (see `cases.ts`) would be a number nobody should
 * trust; the difference between two catalogs scored by the same model on the same
 * cases in the same run is a number you can act on. `compareCatalogs` is
 * therefore the entry point that matters, and it reports the token saving and the
 * accuracy delta **together** — the same "cost and benefit in one view" rule
 * Decision 52 applied to brevity.
 *
 * Honest scoping, stated because the harness exists to prevent self-deception:
 *  - The chooser is whatever `InferenceService` you pass. Locally that is a small
 *    Ollama model, NOT the model that will actually read these descriptions in
 *    production, so a null result here is weaker evidence than it looks. The
 *    model name is recorded in every report for exactly this reason.
 *  - LLM sampling is nondeterministic, so a single pass over ~27 cases cannot
 *    resolve small deltas. `repeats` exists to average, and `verdict` refuses to
 *    call anything a pass or a regression when the delta sits inside sampling
 *    noise.
 *  - A model failure is never scored as a wrong answer. It is counted as `errors`
 *    and excluded, because "the judge was down" and "the model chose badly" are
 *    different facts (the R4.4 refine lesson: no silent zeros).
 */

import type { InferenceService, Role } from "../interfaces/index.js";
import { type ArgumentCase, type ArgumentOutcome, scoreArguments } from "./arguments.js";
import type { SelectionCase } from "./cases.js";
import type { CatalogTool } from "./catalog.js";

/** How one case resolved on one pass. */
export interface CaseOutcome {
  readonly id: string;
  readonly expected: string | null;
  readonly chosen: string | null;
  readonly correct: boolean;
  /** Set when the chooser could not be reached or returned unusable output. */
  readonly error?: string;
}

export interface SelectionRun {
  /** Concrete model that made the choices — accuracy is model-specific. */
  readonly model: string | null;
  readonly repeats: number;
  readonly scored: number;
  readonly correct: number;
  readonly errors: number;
  /** correct / scored, or null when nothing could be scored. */
  readonly accuracy: number | null;
  /** Cases where a tool was chosen but none was expected. */
  readonly falsePositives: number;
  /** Cases where a tool was expected but none was chosen. */
  readonly abstentions: number;
  readonly outcomes: readonly CaseOutcome[];
}

const CHOICE_SCHEMA = {
  type: "object",
  properties: {
    tool: {
      type: "string",
      description: "Exact name of the single best tool, or the empty string for none.",
    },
  },
  required: ["tool"],
  additionalProperties: false,
} as const;

const SYSTEM =
  "You are choosing which tool, if any, should handle a request. You are given a " +
  "list of available tools with their descriptions, and one request. Reply with " +
  "the exact name of the single most appropriate tool. If none of the tools is " +
  "appropriate — the request needs no tool, or needs a capability none of them " +
  "describe — reply with an empty string. Never invent a tool name.";

/**
 * How much of each definition the chooser is shown.
 *
 * `description` is what §89 used and is right for a prose transform. `full` also
 * renders the input schema, and exists because a schema transform scored against a
 * description-only prompt would show a zero delta **by construction** — the harness
 * would be blind, not the transform safe. Whichever is used lands in the report.
 */
export type CatalogRender = "description" | "full";

function renderCatalog(
  tools: readonly CatalogTool[],
  render: CatalogRender = "description",
): string {
  if (render === "description") {
    return tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  }
  return tools
    .map((t) => `- ${t.name}: ${t.description}\n  parameters: ${JSON.stringify(t.schema)}`)
    .join("\n");
}

/**
 * Ways a small model says "no tool", all of which must score as a deliberate
 * abstention rather than an error. Getting this wrong is not cosmetic: the case
 * set is ~19% `expected: null`, so mis-reading abstentions as unusable output
 * both inflates the error count and silently drops the cases that matter most
 * for judging an over-triggering description.
 */
const ABSTENTIONS: ReadonlySet<string> = new Set([
  "",
  "none",
  "null",
  "nil",
  "no tool",
  "no_tool",
  "empty",
  "empty string",
  "n/a",
]);

/** Parse the chooser's reply into a tool name, `null` for none, or undefined if unusable. */
export function parseChoice(
  text: string,
  validNames: ReadonlySet<string>,
): string | null | undefined {
  // Strip a markdown fence first — models wrap JSON in one, and a fence with
  // nothing inside is an abstention, not a parse failure.
  const trimmed = text
    .trim()
    .replace(/^```[a-zA-Z]*\s*/, "")
    .replace(/```$/, "")
    .trim();
  if (trimmed.length === 0) return null;
  let raw: string | undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string") {
      // `""` parses to a bare string, not an object — the schema asked for
      // `{tool}` but a plain quoted value is unambiguous, so honour it.
      raw = parsed;
    } else if (typeof parsed === "object" && parsed !== null && "tool" in parsed) {
      const tool = (parsed as { tool: unknown }).tool;
      if (typeof tool === "string") raw = tool;
    }
  } catch {
    // Not JSON. A small model often answers with a bare name despite the schema;
    // accept that rather than scoring a formatting slip as a wrong choice.
    raw = trimmed;
  }
  if (raw === undefined) return undefined;
  const name = raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  if (ABSTENTIONS.has(name.toLowerCase())) return null;
  return validNames.has(name) ? name : undefined;
}

async function chooseOnce(
  inference: InferenceService,
  role: Role,
  catalogText: string,
  validNames: ReadonlySet<string>,
  testCase: SelectionCase,
): Promise<{ chosen: string | null; model: string | null; error?: string }> {
  try {
    const result = await inference.chat(
      role,
      [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `Available tools:\n${catalogText}\n\nRequest: ${testCase.prompt}`,
        },
      ],
      { temperature: 0, jsonSchema: CHOICE_SCHEMA },
    );
    const chosen = parseChoice(result.text, validNames);
    if (chosen === undefined) {
      return {
        chosen: null,
        model: result.model,
        error: `unparseable choice: ${result.text.slice(0, 80)}`,
      };
    }
    return { chosen, model: result.model };
  } catch (err) {
    return { chosen: null, model: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface RunOptions {
  readonly inference: InferenceService;
  readonly tools: readonly CatalogTool[];
  readonly cases: readonly SelectionCase[];
  /** Passes over the case set; results are pooled. Default 1. */
  readonly repeats?: number;
  /**
   * Local role that does the choosing. Defaults to `classifier`, which is what
   * the task actually is — but the tier's classifier model may not be pulled on
   * a given machine (the R4.4/LE2 failure mode), so the caller can substitute a
   * role it knows is available. Whichever it is, the concrete model lands in
   * {@link SelectionRun.model} and the report prints it: a substitute chooser is
   * a caveat on the result, never a hidden one.
   */
  readonly role?: Role;
  /** How much of each definition to show the chooser. Default `description`. */
  readonly render?: CatalogRender;
}

/** Score one catalog against the case set. */
export async function runSelectionHarness(opts: RunOptions): Promise<SelectionRun> {
  const repeats = Math.max(1, opts.repeats ?? 1);
  const role = opts.role ?? "classifier";
  const catalogText = renderCatalog(opts.tools, opts.render ?? "description");
  const validNames = new Set(opts.tools.map((t) => t.name));
  const outcomes: CaseOutcome[] = [];
  let model: string | null = null;

  for (let pass = 0; pass < repeats; pass++) {
    for (const testCase of opts.cases) {
      const res = await chooseOnce(opts.inference, role, catalogText, validNames, testCase);
      if (res.model !== null) model = res.model;
      const outcome: CaseOutcome =
        res.error === undefined
          ? {
              id: testCase.id,
              expected: testCase.expected,
              chosen: res.chosen,
              correct: res.chosen === testCase.expected,
            }
          : {
              id: testCase.id,
              expected: testCase.expected,
              chosen: null,
              correct: false,
              error: res.error,
            };
      outcomes.push(outcome);
    }
  }

  const errored = outcomes.filter((o) => o.error !== undefined);
  const scoredOutcomes = outcomes.filter((o) => o.error === undefined);
  const correct = scoredOutcomes.filter((o) => o.correct).length;
  return {
    model,
    repeats,
    scored: scoredOutcomes.length,
    correct,
    errors: errored.length,
    accuracy: scoredOutcomes.length === 0 ? null : correct / scoredOutcomes.length,
    falsePositives: scoredOutcomes.filter((o) => o.expected === null && o.chosen !== null).length,
    abstentions: scoredOutcomes.filter((o) => o.expected !== null && o.chosen === null).length,
    outcomes,
  };
}

const ARG_SYSTEM =
  "You are calling a tool. You are given the tool's name, its description, and its " +
  "JSON Schema of parameters, plus one request. Reply with ONLY a JSON object of the " +
  "arguments to pass. Include every required parameter. Include an optional " +
  "parameter only when the request calls for it. Obey the schema exactly: respect " +
  "types, allowed values, and any stated limits. Do not invent parameters that the " +
  "schema does not declare, and do not wrap the object in any other key.";

/** Parse the model's reply into an arguments object, or undefined if unusable. */
export function parseArguments(text: string): Record<string, unknown> | undefined {
  const trimmed = text
    .trim()
    .replace(/^```[a-zA-Z]*\s*/, "")
    .replace(/```$/, "")
    .trim();
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

export type CompareVerdict = "improved" | "no-material-change" | "regressed" | "inconclusive";

/** The argument half of a comparison, present only when argument cases were run. */
export interface ArgumentComparison {
  readonly baseline: ArgumentRun;
  readonly candidate: ArgumentRun;
  readonly cases: number;
  /** candidate − baseline validity against the original schemas. */
  readonly validityDelta: number | null;
  /** candidate − baseline field accuracy. */
  readonly fieldAccuracyDelta: number | null;
}

export interface CatalogComparison {
  readonly baseline: SelectionRun;
  readonly candidate: SelectionRun;
  readonly baselineTokens: number;
  readonly candidateTokens: number;
  readonly tokensSaved: number;
  /** candidate − baseline, in accuracy points (null if either run scored nothing). */
  readonly accuracyDelta: number | null;
  /** Smallest accuracy difference the case set can resolve: one case. */
  readonly resolution: number;
  readonly verdict: CompareVerdict;
  readonly notes: readonly string[];
  /** How much of each definition the chooser saw. */
  readonly render: CatalogRender;
  /** Which half of the definition the token figures measure. */
  readonly measuring: "descriptions" | "schemas";
  /** R8.S1 — argument construction, the failure mode selection cannot see. */
  readonly arguments?: ArgumentComparison;
}

/**
 * A/B two catalogs on the same cases with the same chooser.
 *
 * The verdict is deliberately conservative: a delta smaller than one case's worth
 * of accuracy is `no-material-change`, not "improved". A shrinker earns its keep
 * only on `improved` or `no-material-change` **with** a real token saving.
 */
export async function compareCatalogs(opts: {
  readonly inference: InferenceService;
  readonly baseline: readonly CatalogTool[];
  readonly candidate: readonly CatalogTool[];
  readonly cases: readonly SelectionCase[];
  readonly repeats?: number;
  readonly role?: Role;
  /**
   * How much of each definition the chooser sees. A schema transform must be scored
   * at `full`, or the delta is zero because the prompt never contained the schema.
   */
  readonly render?: CatalogRender;
  /**
   * Which half the token figures measure. `schemas` for a schema transform, so the
   * report cannot claim a saving in the half the transform never touched.
   */
  readonly measuring?: "descriptions" | "schemas";
  /**
   * Argument cases. Supply these for a schema transform: they are the only gate
   * that can see a schema which still selects correctly but no longer says what a
   * parameter means.
   */
  readonly argumentCases?: readonly ArgumentCase[];
}): Promise<CatalogComparison> {
  const render = opts.render ?? "description";
  const measuring = opts.measuring ?? "descriptions";
  const baseline = await runSelectionHarness({
    inference: opts.inference,
    tools: opts.baseline,
    cases: opts.cases,
    render,
    ...(opts.repeats === undefined ? {} : { repeats: opts.repeats }),
    ...(opts.role === undefined ? {} : { role: opts.role }),
  });
  const candidate = await runSelectionHarness({
    inference: opts.inference,
    tools: opts.candidate,
    cases: opts.cases,
    render,
    ...(opts.repeats === undefined ? {} : { repeats: opts.repeats }),
    ...(opts.role === undefined ? {} : { role: opts.role }),
  });

  let argumentComparison: ArgumentComparison | undefined;
  if (opts.argumentCases !== undefined && opts.argumentCases.length > 0) {
    const argBaseline = await runArgumentHarness({
      inference: opts.inference,
      tools: opts.baseline,
      reference: opts.baseline,
      cases: opts.argumentCases,
      ...(opts.repeats === undefined ? {} : { repeats: opts.repeats }),
      ...(opts.role === undefined ? {} : { role: opts.role }),
    });
    const argCandidate = await runArgumentHarness({
      inference: opts.inference,
      tools: opts.candidate,
      // Graded against the ORIGINAL schemas — see `arguments.ts`.
      reference: opts.baseline,
      cases: opts.argumentCases,
      ...(opts.repeats === undefined ? {} : { repeats: opts.repeats }),
      ...(opts.role === undefined ? {} : { role: opts.role }),
    });
    argumentComparison = {
      baseline: argBaseline,
      candidate: argCandidate,
      cases: opts.argumentCases.length,
      validityDelta:
        argBaseline.validity === null || argCandidate.validity === null
          ? null
          : argCandidate.validity - argBaseline.validity,
      fieldAccuracyDelta:
        argBaseline.fieldAccuracy === null || argCandidate.fieldAccuracy === null
          ? null
          : argCandidate.fieldAccuracy - argBaseline.fieldAccuracy,
    };
  }

  const half = (t: CatalogTool): number =>
    measuring === "schemas" ? t.schemaTokens : t.descriptionTokens;
  const baselineTokens = opts.baseline.reduce((n, t) => n + half(t), 0);
  const candidateTokens = opts.candidate.reduce((n, t) => n + half(t), 0);
  const notes: string[] = [];
  const resolution = opts.cases.length === 0 ? 1 : 1 / opts.cases.length;

  const accuracyDelta =
    baseline.accuracy === null || candidate.accuracy === null
      ? null
      : candidate.accuracy - baseline.accuracy;

  let verdict: CompareVerdict;
  if (accuracyDelta === null) {
    verdict = "inconclusive";
    notes.push("at least one run scored nothing — is the local model reachable?");
  } else if (baseline.errors > 0 || candidate.errors > 0) {
    verdict = "inconclusive";
    notes.push(
      `${baseline.errors + candidate.errors} chooser error(s) excluded from scoring; ` +
        "re-run before trusting the delta",
    );
  } else if (Math.abs(accuracyDelta) < resolution) {
    verdict = "no-material-change";
  } else {
    verdict = accuracyDelta > 0 ? "improved" : "regressed";
  }

  if (verdict !== "inconclusive" && Math.abs(accuracyDelta ?? 0) < 2 * resolution) {
    notes.push(
      `delta is within ~${Math.ceil(Math.abs(accuracyDelta ?? 0) / resolution)} case(s) of the ` +
        `baseline on ${opts.cases.length} cases × ${candidate.repeats} repeat(s) — ` +
        "raise repeats or add cases before treating it as signal",
    );
  }
  if (candidateTokens >= baselineTokens) {
    notes.push("the candidate catalog is not smaller — there is nothing to trade accuracy for");
  }

  // The argument half can veto. A schema transform that keeps selection perfect and
  // then stops the model supplying a valid `ref_id` has regressed, and a verdict
  // computed from selection alone would have called that a clean pass — the exact
  // blindness §89's harness would have had if it were reused unchanged for R8.S1.
  if (argumentComparison !== undefined) {
    const argResolution =
      argumentComparison.cases === 0 ? 1 : 1 / (argumentComparison.cases * candidate.repeats);
    const worst = Math.min(
      argumentComparison.validityDelta ?? 0,
      argumentComparison.fieldAccuracyDelta ?? 0,
    );
    if (
      argumentComparison.validityDelta === null ||
      argumentComparison.fieldAccuracyDelta === null
    ) {
      verdict = "inconclusive";
      notes.push("the argument harness scored nothing — is the local model reachable?");
    } else if (argumentComparison.baseline.errors > 0 || argumentComparison.candidate.errors > 0) {
      notes.push(
        `${argumentComparison.baseline.errors + argumentComparison.candidate.errors} ` +
          "argument-harness error(s) excluded from scoring",
      );
    }
    if (worst <= -argResolution && verdict !== "inconclusive") {
      verdict = "regressed";
      notes.push(
        "argument construction got worse even though selection did not — this is the " +
          "failure mode a selection-only gate cannot see",
      );
    }
  } else if (measuring === "schemas") {
    notes.push(
      "no argument cases were run, so this scored a schema transform against a gate " +
        "that cannot see schemas — treat the delta as meaningless",
    );
  }
  if (measuring === "schemas" && render === "description") {
    notes.push(
      "the chooser was shown descriptions only, so a schema transform could not " +
        "affect selection at all — re-run with the full render",
    );
  }

  return {
    baseline,
    candidate,
    baselineTokens,
    candidateTokens,
    tokensSaved: baselineTokens - candidateTokens,
    accuracyDelta,
    resolution,
    verdict,
    notes,
    render,
    measuring,
    ...(argumentComparison !== undefined && { arguments: argumentComparison }),
  };
}
