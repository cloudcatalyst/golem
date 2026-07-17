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

/**
 * Is this source a documentation/prose file (as opposed to source code or tests)?
 *
 * The local-answer path is EXTRACTIVE — it quotes a retrieved chunk verbatim as
 * the answer. A raw source-code or test chunk is almost never a good answer to a
 * definitional/conceptual question, and (verification-notes §64/§69b, Decision 33
 * finding #2) dense-token code/test chunks reliably OUTRANK explanatory prose for
 * such questions — e.g. `const LEVEL_0 = sliderPolicyForLevel(0)` in a test file
 * scored *above* the correct "slider level 0 = passthrough" prose. So local-answer
 * only serves from prose sources; if none clears the confidence floor it declines
 * and the request falls through to the upstream model (the safe outcome —
 * serving a wrong answer is worse than serving none).
 */
export function isProseSource(sourcePath: string | undefined): boolean {
  if (sourcePath === undefined) return false;
  const p = sourcePath.replace(/\\/g, "/").toLowerCase();
  return /\.(md|markdown|mdx|txt|rst)$/.test(p);
}

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
    // Fetch a WIDER candidate set than we'll serve, then keep only prose sources
    // (see isProseSource): dense-token code/test chunks otherwise crowd prose out
    // of the top-k, so a narrow fetch would strand the correct explanation below
    // the cut. Restrict-to-prose is applied before the confidence floor, so a
    // query with no confident prose answer declines rather than serving code.
    const candidates = await this.#search.search(
      query.text,
      query.projectId,
      Math.max(this.#k * 4, 12),
      new Set(["knowledge"]),
    );
    const prose = candidates.filter((h) => isProseSource(h.chunk.sourcePath)).slice(0, this.#k);
    const result = composeFromHits(prose, this.#minConfidence);
    if (!result.answered) return result;
    return { ...result, text: `${LOCAL_ANSWER_LABEL}\n\n${result.text}` };
  }
}
