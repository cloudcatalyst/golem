/**
 * The arithmetic Golem's benchmark harnesses share.
 *
 * `golem bench tools`, `golem bench map` and `golem bench edit` are separate
 * instruments measuring different things, but they answer to the same three
 * rules, and those rules are arithmetic:
 *
 *  - **a rate is printed the same way everywhere**, and `null` prints as `n/a`
 *    rather than as `0.0%` — the R4.4 lesson that a dead judge must never read
 *    as a bad score;
 *  - **a case set can only resolve one case's worth of difference**, so every
 *    verdict has a floor below which it must decline to call anything a result;
 *  - **an excluded model error is not a free pass**. Every harness re-scores
 *    its errors the way that hurts its own candidate most and checks whether
 *    the verdict survives. That re-scoring is {@link worstCaseRate} and
 *    {@link bestCaseRate}.
 *
 * Kept in its own leaf module — importing nothing, imported by `src/tools/`,
 * `src/knowledge/` and `src/telemetry/` — because the harnesses live beside the
 * features they gate and no one of them is upstream of the others.
 *
 * What is deliberately NOT here: the decision rules themselves. The repo-map
 * gate asks whether an adverse delta keeps its sign; the edit gate asks whether
 * an adverse rate still clears a pre-registered bar. Those are different
 * questions with different answers, and collapsing them would change published
 * verdicts rather than deduplicate them.
 */

/** A rate as a percentage to one decimal. `null` is "not scored", never zero. */
export function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

/**
 * The same, with an explicit `+` on a gain — a delta whose direction has to be
 * inferred from a minus sign is a delta someone will read backwards.
 */
export function signedPct(value: number | null): string {
  if (value === null) return "n/a";
  const s = (value * 100).toFixed(1);
  return value > 0 ? `+${s}%` : `${s}%`;
}

/**
 * The finest accuracy difference a case set can resolve: one case.
 *
 * An empty set resolves nothing, so it returns 1 — every conceivable delta then
 * sits inside the resolution, and the verdict declines. That is the correct
 * refusal, not a divide-by-zero dodge.
 */
export function caseResolution(cases: number): number {
  return cases === 0 ? 1 : 1 / cases;
}

/**
 * The rate when every excluded error is re-scored as a failure — the harshest
 * reading of a run.
 *
 * Returns `null` when there was nothing to score at all, which is a different
 * fact from "scored zero" and must stay distinguishable.
 */
export function worstCaseRate(successes: number, scored: number, errors: number): number | null {
  const total = scored + errors;
  return total === 0 ? null : successes / total;
}

/**
 * The rate when every excluded error is re-scored as a success — the most
 * generous reading. Paired with {@link worstCaseRate} to bracket a comparison
 * the way that hurts the candidate most: candidate at its worst, baseline at
 * its best.
 */
export function bestCaseRate(successes: number, scored: number, errors: number): number | null {
  const total = scored + errors;
  return total === 0 ? null : (successes + errors) / total;
}
