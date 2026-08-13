/**
 * Workstream B / R8.S1 — the A/B that decides whether a tools-block transform ships.
 *
 * The shape is deliberately an **A/B**, not an absolute score. Absolute accuracy
 * against hand-written labels (see `cases.ts`) would be a number nobody should
 * trust; the difference between two catalogs scored by the same model on the same
 * cases in the same run is a number you can act on. This is therefore the entry
 * point that matters, and it reports the token saving and the accuracy delta
 * **together** — the same "cost and benefit in one view" rule Decision 52 applied
 * to brevity.
 *
 * LLM sampling is nondeterministic, so a single pass over ~27 cases cannot resolve
 * small deltas. `repeats` exists to average, and the verdict refuses to call
 * anything a pass or a regression when the delta sits inside sampling noise.
 *
 * A note on the verdict rule, because it looks like an oversight and is not: this
 * comparison treats **any** chooser error as unconditionally `inconclusive`,
 * where the later repo-map and edit gates instead re-score their errors
 * adversarially and keep a verdict that survives. That is the older, cruder rule,
 * and it stays. Loosening it would change what an already-published measurement
 * reports, which is a different act from refactoring the code that reports it.
 */

import { caseResolution } from "../bench/stats.js";
import type { InferenceService, Role } from "../interfaces/index.js";
import { type ArgumentRun, runArgumentHarness } from "./argument-harness.js";
import type { ArgumentCase } from "./arguments.js";
import type { SelectionCase } from "./cases.js";
import type { CatalogTool } from "./catalog.js";
import { type CatalogRender, runSelectionHarness, type SelectionRun } from "./selection.js";

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
 * Let the argument half veto a verdict the selection half was happy with.
 *
 * A schema transform that keeps selection perfect and then stops the model
 * supplying a valid `ref_id` has regressed, and a verdict computed from selection
 * alone would have called that a clean pass — the exact blindness §89's harness
 * would have had if it were reused unchanged for R8.S1.
 *
 * Returns the verdict to adopt plus the notes to append, rather than mutating
 * either, so the veto can be exercised without standing up two model runs.
 */
export function applyArgumentVeto(
  comparison: ArgumentComparison,
  verdict: CompareVerdict,
  repeats: number,
): { readonly verdict: CompareVerdict; readonly notes: readonly string[] } {
  const notes: string[] = [];
  const argResolution = caseResolution(comparison.cases * repeats);
  const worst = Math.min(comparison.validityDelta ?? 0, comparison.fieldAccuracyDelta ?? 0);
  let next = verdict;

  if (comparison.validityDelta === null || comparison.fieldAccuracyDelta === null) {
    next = "inconclusive";
    notes.push("the argument harness scored nothing — is the local model reachable?");
  } else if (comparison.baseline.errors > 0 || comparison.candidate.errors > 0) {
    notes.push(
      `${comparison.baseline.errors + comparison.candidate.errors} ` +
        "argument-harness error(s) excluded from scoring",
    );
  }
  if (worst <= -argResolution && next !== "inconclusive") {
    next = "regressed";
    notes.push(
      "argument construction got worse even though selection did not — this is the " +
        "failure mode a selection-only gate cannot see",
    );
  }
  return { verdict: next, notes };
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
  const resolution = caseResolution(opts.cases.length);

  const accuracyDelta =
    baseline.accuracy === null || candidate.accuracy === null
      ? null
      : candidate.accuracy - baseline.accuracy;

  // Deliberately the older, cruder rule — see the module header before "fixing" it.
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

  if (argumentComparison !== undefined) {
    const veto = applyArgumentVeto(argumentComparison, verdict, candidate.repeats);
    verdict = veto.verdict;
    notes.push(...veto.notes);
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
