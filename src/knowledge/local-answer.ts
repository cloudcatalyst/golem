/**
 * R2.3 (spec Decision 24 sub-mode 2 / Decision 33) — the LocalAnswerService
 * implementation: a thin, confidence-gated wrapper over the existing
 * FederatedSearch read path. Extractive only — it never calls a generative
 * model, so it cannot fabricate; it either finds confidently-covering KB
 * hits and quotes them, or says `answered: false`.
 */

import type { FederatedSearch } from "../interfaces/knowledge.js";
import {
  composeFromHits,
  type LocalAnswerQuery,
  type LocalAnswerResult,
  type LocalAnswerService,
} from "../interfaces/local-answer.js";

/** Conservative default — see verification-notes for the rationale (no calibration data yet). */
export const DEFAULT_MIN_CONFIDENCE = 0.6;

export const LOCAL_ANSWER_LABEL =
  "**Golem** Answered locally from the project knowledge base — verify independently.";

export interface KnowledgeLocalAnswerOptions {
  /** Minimum Hit.score required to serve an answer. Default {@link DEFAULT_MIN_CONFIDENCE}. */
  readonly minConfidence?: number;
  /** How many top hits to search for before filtering by confidence. Default 3. */
  readonly k?: number;
}

export class KnowledgeLocalAnswerService implements LocalAnswerService {
  readonly #search: FederatedSearch;
  readonly #minConfidence: number;
  readonly #k: number;

  constructor(search: FederatedSearch, options: KnowledgeLocalAnswerOptions = {}) {
    this.#search = search;
    this.#minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    this.#k = options.k ?? 3;
  }

  async tryAnswer(query: LocalAnswerQuery): Promise<LocalAnswerResult> {
    const hits = await this.#search.search(
      query.text,
      query.projectId,
      this.#k,
      new Set(["knowledge"]),
    );
    const result = composeFromHits(hits, this.#minConfidence);
    if (!result.answered) return result;
    return { ...result, text: `${LOCAL_ANSWER_LABEL}\n\n${result.text}` };
  }
}
