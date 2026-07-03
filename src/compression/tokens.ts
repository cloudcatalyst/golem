/**
 * Deterministic token estimation for savings accounting.
 *
 * A2 deliberately ships a tokenizer-free heuristic (~4 chars/token, the usual
 * English/code approximation) instead of a real BPE vocabulary: savings
 * accounting only needs relative before/after numbers, exact counts come from
 * the Anthropic API's usage block via telemetry (task A4), and a vocabulary
 * download would violate the "no heavyweight deps in the default install"
 * hard rule.
 *
 * MUST stay a pure function of its input — dedup markers embed the estimated
 * token count, so a non-deterministic estimator would break prompt-cache
 * prefix stability (verification-notes.md §14).
 */

/** Estimate the token count of `text` (~4 chars/token; 0 only for ""). */
export function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}
