/**
 * P3a — the COST side of compaction (Decision 52): how much of what the file
 * INSTRUCTED survives a rewrite, measured without the model. Extracted verbatim
 * from `./compact.js`.
 *
 * Deliberately free of the rewrite machinery. A model-judged fidelity score
 * would be the more satisfying number and the less trustworthy one — it needs
 * the same local model that just produced the rewrite, so it disappears exactly
 * when that model is unavailable. Everything here is deterministic text
 * analysis, so the cost side is always computable and can never quietly vanish.
 */

import { segmentMarkdown } from "./compact-segment.js";

/* ------------------------------------------------------------------------- *
 * The COST side: directive coverage, computed without the model.
 * ------------------------------------------------------------------------- */

const STOPWORDS = new Set([
  "that",
  "this",
  "with",
  "from",
  "have",
  "here",
  "when",
  "then",
  "than",
  "they",
  "them",
  "your",
  "into",
  "only",
  "also",
  "each",
  "some",
  "more",
  "most",
  "such",
  "very",
  "will",
  "would",
  "should",
  "could",
  "been",
  "being",
  "does",
  "done",
  "over",
  "under",
  "just",
  "like",
  "what",
  "which",
  "while",
  "where",
  "there",
  "their",
  "about",
  "after",
  "before",
]);

/** Words that mark a line as carrying an instruction rather than description. */
const DIRECTIVE_RE =
  /\b(?:must|never|always|do not|don't|avoid|prefer|require[ds]?|forbidden|ensure|only|use|run|keep|write|add|check|verify|treat|call|start)\b/i;

export interface Directive {
  readonly text: string;
  /** Fraction of the directive's content words still present in the rewrite. */
  readonly coverage: number;
  /** Content words that vanished — the actionable half of the cost report. */
  readonly missing: readonly string[];
}

/** A directive counts as preserved at or above this coverage. */
export const COVERAGE_THRESHOLD = 0.6;

/**
 * Crude suffix stripper, so "reordered" in the original matches "reorder" in
 * the rewrite. A rewrite is allowed to change inflection — that is compaction —
 * and scoring it as a dropped rule would make the cost figure cry wolf.
 */
function stem(word: string): string {
  let out = word;
  // To a fixpoint, so stemming is SYMMETRIC: one pass turns "reordered" into
  // "reorder" but "reorder" into "reord", and the two would never match.
  for (let pass = 0; pass < 4; pass += 1) {
    const before = out;
    for (const suffix of ["ing", "ers", "ed", "es", "er", "s"]) {
      if (out.length > suffix.length + 3 && out.endsWith(suffix)) {
        out = out.slice(0, -suffix.length);
        break;
      }
    }
    if (out === before) break;
  }
  return out;
}

function contentWords(line: string): string[] {
  const words = line.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [];
  return [...new Set(words.filter((w) => !STOPWORDS.has(w)).map(stem))];
}

/**
 * Pull the instruction-bearing lines out of the ORIGINAL document.
 *
 * Bullets and any line containing a modal/imperative marker. Headings, code and
 * frontmatter are excluded — they are passed through unrewritten anyway, so
 * scoring them would inflate the fidelity number for free.
 */
export function extractDirectives(original: string): string[] {
  const out: string[] = [];
  for (const seg of segmentMarkdown(original)) {
    if (seg.kind !== "prose") continue;
    for (const raw of seg.text.split("\n")) {
      const line = raw.trim();
      if (line.length < 12) continue;
      const isBullet = /^([-*+]|\d+\.)\s/.test(line);
      if (!isBullet && !DIRECTIVE_RE.test(line)) continue;
      if (contentWords(line).length < 2) continue;
      out.push(line);
    }
  }
  return out;
}

/**
 * Score each directive against the rewrite.
 *
 * Deterministic on purpose. A model-judged fidelity score would be the more
 * satisfying number and the less trustworthy one: it needs the same local model
 * that just produced the rewrite, and it disappears exactly when that model is
 * unavailable. Word survival is a weak proxy, stated as one in the report —
 * but it is always computable and it cannot flatter the rewrite.
 */
export function scoreDirectives(original: string, rewritten: string): Directive[] {
  const haystack = new Set((rewritten.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []).map(stem));
  return extractDirectives(original).map((text) => {
    const words = contentWords(text);
    const missing = words.filter((w) => !haystack.has(w));
    const coverage = words.length === 0 ? 1 : (words.length - missing.length) / words.length;
    return { text, coverage, missing };
  });
}
