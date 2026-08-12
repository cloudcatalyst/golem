/**
 * Reading a small model's *constrained* reply.
 *
 * Three harnesses ask a local model for one short structured answer — a tool
 * name and an arguments object (both `src/tools/selection.ts`) and a
 * repo-relative path (`src/knowledge/repo-map-bench.ts`) — and all three then
 * have to survive the
 * same handful of 7B-class habits: the answer arrives wrapped in a markdown
 * fence, or as a bare value that ignores the JSON schema entirely, or buried in
 * a sentence.
 *
 * This module exists so those habits are handled in ONE place. The stakes are
 * higher than tidiness: a harness that misreads a deliberate abstention as
 * unusable output does not merely lose a case, it inflates the `errors` count
 * that the adverse-case guard then uses to withhold a verdict. Three copies of
 * this logic drifting apart is three sets of published numbers drifting apart.
 *
 * It lives under `src/inference/` because both `src/tools/` and
 * `src/knowledge/` consume it and neither is upstream of the other, while
 * `src/inference/` is upstream of both and imports from neither. Nothing here
 * talks to a model — it only reads what one already said.
 */

/**
 * Strip a markdown fence, and the whitespace around it.
 *
 * A fence with nothing inside must come back as the empty string: that is an
 * abstention ("no tool applies", "no file fits"), not a parse failure, and
 * scoring it as the latter both inflates the error count and silently drops the
 * cases that matter most for judging an over-triggering description.
 */
export function stripFence(text: string): string {
  return text
    .trim()
    .replace(/^```[a-zA-Z]*\s*/u, "")
    .replace(/```$/u, "")
    .trim();
}

/**
 * Pull one string field out of an already-defenced reply.
 *
 * Three shapes are accepted, because a small model produces all three for the
 * same schema:
 *  - `{"path":"src/a.ts"}` — the shape that was actually asked for;
 *  - `"src/a.ts"` — a bare quoted value, which `JSON.parse` yields as a plain
 *    string rather than an object. Honouring it is not leniency for its own
 *    sake: `""` parses this way, and an object-only branch threw away 4 of the
 *    5 "errors" in one real run, every one of them a correct abstention;
 *  - `src/a.ts` — not JSON at all. A formatting slip is not a wrong answer, so
 *    the raw text is handed back for the caller to validate.
 *
 * `undefined` means the reply was JSON but carried no string in that field —
 * genuinely unusable, and the caller's business to count as an error.
 */
export function readReplyField(text: string, key: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "string") return parsed;
    if (typeof parsed === "object" && parsed !== null && key in parsed) {
      const value = (parsed as Record<string, unknown>)[key];
      return typeof value === "string" ? value : undefined;
    }
    return undefined;
  } catch {
    return text;
  }
}

/**
 * Recover a known value that the model mentioned inside a sentence.
 *
 * The last resort after an exact match fails, and deliberately the last one: it
 * accepts the FIRST known value that appears anywhere in the reply, so it can
 * only ever rescue a reply that names something real. An invented value still
 * comes back `undefined`, which the harnesses count as an error rather than as
 * a wrong answer.
 */
export function recoverKnownValue(text: string, known: Iterable<string>): string | undefined {
  for (const candidate of known) {
    if (text.includes(candidate)) return candidate;
  }
  return undefined;
}
