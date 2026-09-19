/**
 * Turning two readings of the same file into a statement about preference.
 *
 * A CORRECTION is the strongest style signal there is: the agent wrote X, the
 * human changed it to Y, and unlike a seeded exemplar there is no ambiguity
 * about whether they meant it. This module is what reads that intent out of the
 * two observations — and, just as importantly, what refuses to.
 *
 * The refusals matter more than the detections. A file with four semicolon
 * candidates can flip from "uses them" to "doesn't" on a single edited line, and
 * a candidate raised from that is noise the human then has to decline. So every
 * metric carries a minimum amount of evidence it needs on BOTH sides before it
 * is allowed to claim anything, and a metric that merely got stronger in the
 * direction it already pointed is not a change at all.
 */

import { dominantIndentWidth, type StyleObservation } from "./analyze.js";

export type SignalKind =
  | "quotes"
  | "semicolons"
  | "indent-kind"
  | "indent-width"
  | "line-width"
  | "comment-density"
  | "comment-case"
  | "comment-terminator";

/** One observed change of mind, in the human's direction. */
export interface StyleSignal {
  readonly kind: SignalKind;
  /** What the agent wrote. */
  readonly from: string;
  /** What the human changed it to. */
  readonly to: string;
}

/**
 * A single metric: how to read it, and how much evidence it needs.
 *
 * `read` returns null when the observation cannot support a claim — too few
 * lines, no comments, no indented lines. Null on either side means no signal,
 * which is how "the file was too small to tell" stays distinct from "the
 * preference did not change".
 */
interface Metric {
  readonly kind: SignalKind;
  read(o: StyleObservation): string | null;
}

/** Percentage helper that refuses to divide by zero. */
const share = (n: number, d: number): number => (d === 0 ? 0 : n / d);

const METRICS: readonly Metric[] = [
  {
    kind: "quotes",
    read: (o) => {
      const total = o.quoteDouble + o.quoteSingle;
      // Four quote characters is two strings — below that a single edited line
      // decides the whole file.
      if (total < 4) return null;
      return o.quoteDouble >= o.quoteSingle ? "double" : "single";
    },
  },
  {
    kind: "semicolons",
    read: (o) => {
      if (o.terminatorCandidates < 4) return null;
      return share(o.semicolonLines, o.terminatorCandidates) >= 0.5 ? "yes" : "no";
    },
  },
  {
    kind: "indent-kind",
    read: (o) => {
      const total = o.indentTabs + o.indentSpaces;
      if (total < 3) return null;
      return o.indentTabs > o.indentSpaces ? "tabs" : "spaces";
    },
  },
  {
    kind: "indent-width",
    read: (o) => {
      // Only meaningful for space indentation, and only when a width is agreed.
      if (o.indentSpaces < 3 || o.indentTabs > o.indentSpaces) return null;
      const width = dominantIndentWidth(o);
      return width === null ? null : String(width);
    },
  },
  {
    kind: "line-width",
    read: (o) => {
      if (o.lines < 10) return null;
      if (share(o.widthLe80, o.lines) >= 0.9) return "80";
      if (share(o.widthLe100, o.lines) >= 0.9) return "100";
      if (share(o.widthLe120, o.lines) >= 0.9) return "120";
      return "unbounded";
    },
  },
  {
    kind: "comment-density",
    read: (o) => {
      if (o.lines < 20) return null;
      const pct = share(o.commentLine + o.commentBlock, o.lines);
      // Buckets, not a percentage: a two-point move is not a change of mind,
      // and comparing raw percentages would raise a candidate on every edit.
      if (pct < 0.05) return "sparse";
      if (pct < 0.2) return "moderate";
      return "heavy";
    },
  },
  {
    kind: "comment-case",
    read: (o) => {
      if (o.commentsCounted < 3) return null;
      return share(o.commentCapitalStart, o.commentsCounted) >= 0.6 ? "capitalised" : "lowercase";
    },
  },
  {
    kind: "comment-terminator",
    read: (o) => {
      if (o.commentsCounted < 3) return null;
      return share(o.commentEndsPeriod, o.commentsCounted) >= 0.6 ? "punctuated" : "bare";
    },
  },
];

/**
 * What the human changed, reading `before` as the agent's version and `after` as
 * theirs.
 *
 * Returns an empty array for the overwhelmingly common case — a real edit that
 * says nothing about style — and that emptiness is the point. A capture layer
 * that produced a candidate per edit would be a queue nobody reads.
 */
export function diffObservations(before: StyleObservation, after: StyleObservation): StyleSignal[] {
  const signals: StyleSignal[] = [];
  for (const metric of METRICS) {
    const from = metric.read(before);
    const to = metric.read(after);
    if (from === null || to === null || from === to) continue;
    signals.push({ kind: metric.kind, from, to });
  }
  return signals;
}

/**
 * Stable identity for a signal, so the same correction made twice is the SAME
 * candidate seen twice rather than two candidates.
 *
 * Deliberately excludes the file it came from: "prefers single quotes" is one
 * preference whether it was corrected in one file or in nine — and the number of
 * distinct files it was seen in is exactly the evidence the quiz should weigh.
 */
export function signalKey(signal: StyleSignal): string {
  return `${signal.kind}:${signal.from}->${signal.to}`;
}

/** One line of human-readable prose for a signal, used by the quiz and the guide. */
export function describeSignal(signal: StyleSignal): string {
  switch (signal.kind) {
    case "quotes":
      return `prefers ${signal.to} quotes (changed from ${signal.from})`;
    case "semicolons":
      return signal.to === "yes"
        ? "terminates statements with semicolons"
        : "omits statement semicolons";
    case "indent-kind":
      return `indents with ${signal.to} rather than ${signal.from}`;
    case "indent-width":
      return `indents ${signal.to} spaces rather than ${signal.from}`;
    case "line-width":
      return signal.to === "unbounded"
        ? `does not hold lines to ${signal.from} columns`
        : `holds lines within ${signal.to} columns (was ${signal.from})`;
    case "comment-density":
      return `comments more ${signal.to === "heavy" ? "heavily" : signal.to === "sparse" ? "sparsely" : "moderately"} than ${signal.from}`;
    case "comment-case":
      return signal.to === "capitalised"
        ? "starts comments with a capital letter"
        : "starts comments in lower case";
    case "comment-terminator":
      return signal.to === "punctuated"
        ? "ends comments with punctuation"
        : "leaves comments unpunctuated";
  }
}
