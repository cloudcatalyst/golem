/**
 * LocalAnswerService — FROZEN CONTRACT (R2.3, spec Decision 24 sub-mode 2 /
 * Decision 33).
 *
 * The aggressive, opt-in "proxy-as-responder" sub-mode: given a single-turn,
 * retrieval-shaped query, decide whether the project's knowledge base can
 * answer it without an upstream call at all, and if so, produce an
 * extractive, sourced answer built directly from retrieved chunks — never a
 * free-generated one, so it cannot fabricate.
 *
 * Contract notes (binding on implementations):
 * - A low-confidence or empty search result MUST resolve `{ answered: false
 *   }` — the caller then falls through to the normal upstream path. There is
 *   no partial/uncertain answer; either confident enough to serve, or not
 *   served at all.
 * - The answer text is composed FROM `sources` (extractive), never phrased
 *   freely by a generative call — the faithfulness gate this contract exists
 *   to enforce.
 * - Independent of `slider.level` (Decision 31: the slider is a pure
 *   compression-aggressiveness dial). This path has its own opt-in gate
 *   (`knowledge.local_answer_enabled`) so enabling it never changes what the
 *   slider means.
 * - Never called for a request already known to be mid-tool-use or
 *   multi-turn — that eligibility check is the caller's (pipeline's)
 *   responsibility, not this service's; `tryAnswer` itself is unconditional
 *   given a query.
 */

import type { Hit } from "./knowledge.js";

/** A single-turn, retrieval-shaped question posed to the local KB. */
export interface LocalAnswerQuery {
  readonly text: string;
  readonly projectId: string;
}

/** One KB hit the answer was extracted from. */
export interface LocalAnswerSource {
  readonly sourcePath?: string;
  readonly score: number;
}

export type LocalAnswerResult =
  | { readonly answered: false }
  | {
      readonly answered: true;
      /** Extractive answer text, already labeled (caller does not re-label). */
      readonly text: string;
      readonly sources: readonly LocalAnswerSource[];
    };

export interface LocalAnswerService {
  tryAnswer(query: LocalAnswerQuery): Promise<LocalAnswerResult>;
}

/** Pure helper: turn ranked KB hits into a LocalAnswerResult given a confidence floor. */
export function composeFromHits(hits: readonly Hit[], minConfidence: number): LocalAnswerResult {
  const top = hits.filter((h) => h.score >= minConfidence);
  if (top.length === 0) return { answered: false };
  const text = top.map((h) => h.chunk.text.trim()).join("\n\n---\n\n");
  const sources: LocalAnswerSource[] = top.map((h) => ({
    ...(h.chunk.sourcePath !== undefined ? { sourcePath: h.chunk.sourcePath } : {}),
    score: h.score,
  }));
  return { answered: true, text, sources };
}
