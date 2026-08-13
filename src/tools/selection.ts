/**
 * Workstream B — the tool-selection-accuracy harness.
 *
 * §88 parked the tools-block shrinker on one blocker: shortening a tool
 * description changes *instructions the model reads to decide whether to call the
 * tool*, and there was no way to measure whether selection behaviour survived.
 * This is that measurement.
 *
 * What is here is one arm of that measurement: score one catalog against the case
 * set. It is deliberately not the entry point. An absolute accuracy against
 * hand-written labels (see `cases.ts`) is a number nobody should trust; only the
 * difference between two catalogs scored by the same model on the same cases in
 * the same run is actionable, so `./compare-catalogs.ts` — which runs this twice
 * and reports the delta beside the token saving — is what callers should reach for.
 *
 * Honest scoping, stated because the harness exists to prevent self-deception:
 *  - The chooser is whatever `InferenceService` you pass. Locally that is a small
 *    Ollama model, NOT the model that will actually read these descriptions in
 *    production, so a null result here is weaker evidence than it looks. The
 *    model name is recorded in every report for exactly this reason.
 *  - LLM sampling is nondeterministic, so a single pass over ~27 cases cannot
 *    resolve small deltas. `repeats` exists to average, and the comparison's
 *    verdict refuses to call anything a pass or a regression when the delta sits
 *    inside sampling noise.
 *  - A model failure is never scored as a wrong answer. It is counted as `errors`
 *    and excluded, because "the judge was down" and "the model chose badly" are
 *    different facts (the R4.4 refine lesson: no silent zeros).
 */

import { readReplyField, stripFence } from "../inference/reply-parsing.js";
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
  const trimmed = stripFence(text);
  if (trimmed.length === 0) return null;
  // All three shapes a small model produces for this schema: the `{"tool":…}` that
  // was asked for, a bare quoted value (`""` parses that way, and reading it as
  // unusable would throw away correct abstentions), and text that is not JSON at
  // all — a formatting slip is not a wrong choice, so it is validated below.
  const raw = readReplyField(trimmed, "tool");
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
