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

function renderCatalog(tools: readonly CatalogTool[]): string {
  return tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
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
}

/** Score one catalog against the case set. */
export async function runSelectionHarness(opts: RunOptions): Promise<SelectionRun> {
  const repeats = Math.max(1, opts.repeats ?? 1);
  const role = opts.role ?? "classifier";
  const catalogText = renderCatalog(opts.tools);
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

export type CompareVerdict = "improved" | "no-material-change" | "regressed" | "inconclusive";

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
}): Promise<CatalogComparison> {
  const baseline = await runSelectionHarness({
    inference: opts.inference,
    tools: opts.baseline,
    cases: opts.cases,
    ...(opts.repeats === undefined ? {} : { repeats: opts.repeats }),
    ...(opts.role === undefined ? {} : { role: opts.role }),
  });
  const candidate = await runSelectionHarness({
    inference: opts.inference,
    tools: opts.candidate,
    cases: opts.cases,
    ...(opts.repeats === undefined ? {} : { repeats: opts.repeats }),
    ...(opts.role === undefined ? {} : { role: opts.role }),
  });

  const baselineTokens = opts.baseline.reduce((n, t) => n + t.descriptionTokens, 0);
  const candidateTokens = opts.candidate.reduce((n, t) => n + t.descriptionTokens, 0);
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
  };
}
