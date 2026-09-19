/**
 * Measurable style facts, extracted from source text.
 *
 * Everything here is COUNTED, never inferred. A style guide that guesses is
 * worse than no style guide, because the user cannot tell which half to trust —
 * so this module reports what it can prove from the bytes (indent, quotes,
 * terminators, line widths, comment shape, identifier casing) and leaves the
 * judgement calls to the prose brief, which the human confirms.
 *
 * Deliberately language-agnostic and dependency-free: no parser, no ML, nothing
 * that could pull a native dependency into the default install. It is a set of
 * line-level heuristics, and the guideline it produces says so.
 */

/** Counters from one or many files. Additive, so files merge by summing. */
export interface StyleObservation {
  files: number;
  /** Non-blank lines seen. */
  lines: number;
  indentTabs: number;
  indentSpaces: number;
  /** Space-indent width -> how many indented lines are a multiple of it. */
  indentWidths: Record<number, number>;
  quoteSingle: number;
  quoteDouble: number;
  quoteBacktick: number;
  /** Code lines ending in a semicolon, over lines where that was a real choice. */
  semicolonLines: number;
  terminatorCandidates: number;
  /** Line-width histogram, by the ceilings people actually argue about. */
  widthLe80: number;
  widthLe100: number;
  widthLe120: number;
  widthMax: number;
  commentLine: number;
  commentBlock: number;
  commentCapitalStart: number;
  commentEndsPeriod: number;
  commentWords: number;
  commentsCounted: number;
  /** Identifier casing, sampled from declarations. */
  camelCase: number;
  snakeCase: number;
  pascalCase: number;
  screamingCase: number;
  /** Files whose first line is a comment (a header-comment habit). */
  fileHeaderComment: number;
}

export function emptyObservation(): StyleObservation {
  return {
    files: 0,
    lines: 0,
    indentTabs: 0,
    indentSpaces: 0,
    indentWidths: {},
    quoteSingle: 0,
    quoteDouble: 0,
    quoteBacktick: 0,
    semicolonLines: 0,
    terminatorCandidates: 0,
    widthLe80: 0,
    widthLe100: 0,
    widthLe120: 0,
    widthMax: 0,
    commentLine: 0,
    commentBlock: 0,
    commentCapitalStart: 0,
    commentEndsPeriod: 0,
    commentWords: 0,
    commentsCounted: 0,
    camelCase: 0,
    snakeCase: 0,
    pascalCase: 0,
    screamingCase: 0,
    fileHeaderComment: 0,
  };
}

/** Declaration keywords across the languages this is likely to meet. */
const DECL =
  /\b(?:const|let|var|function|class|def|fn|func|type|interface|struct)\s+([A-Za-z_$][\w$]*)/g;

function classifyIdentifier(name: string, into: StyleObservation): void {
  if (/^[A-Z0-9_]+$/.test(name) && name.includes("_")) into.screamingCase += 1;
  else if (/^[A-Z][A-Za-z0-9]*$/.test(name)) into.pascalCase += 1;
  else if (name.includes("_")) into.snakeCase += 1;
  else if (/^[a-z][A-Za-z0-9]*$/.test(name) && /[A-Z]/.test(name)) into.camelCase += 1;
}

function countCommentProse(body: string, into: StyleObservation): void {
  const text = body.trim();
  if (text === "") return;
  into.commentsCounted += 1;
  into.commentWords += text.split(/\s+/).length;
  if (/^[A-Z]/.test(text)) into.commentCapitalStart += 1;
  if (/[.!?]$/.test(text)) into.commentEndsPeriod += 1;
}

/**
 * Fold one file's text into an observation.
 *
 * Mutates and returns `into`, so a whole tree folds without allocating per file.
 */
export function observeSource(
  text: string,
  into: StyleObservation = emptyObservation(),
): StyleObservation {
  into.files += 1;
  const lines = text.split(/\r?\n/);
  if (/^\s*(\/\*|\/\/|#|--)/.test(lines[0] ?? "")) into.fileHeaderComment += 1;

  let inBlockComment = false;
  for (const line of lines) {
    if (line.trim() === "") continue;
    into.lines += 1;

    const width = line.length;
    if (width <= 80) into.widthLe80 += 1;
    if (width <= 100) into.widthLe100 += 1;
    if (width <= 120) into.widthLe120 += 1;
    if (width > into.widthMax) into.widthMax = width;

    const trimmed = line.trim();
    const opensBlock = trimmed.startsWith("/*");
    if (inBlockComment || opensBlock) {
      into.commentBlock += 1;
      if (opensBlock && !trimmed.includes("*/")) inBlockComment = true;
      if (inBlockComment && trimmed.includes("*/")) inBlockComment = false;
      countCommentProse(trimmed.replace(/^[/*\s]+/, ""), into);
      continue;
    }
    if (/^(\/\/|#|--|;;)/.test(trimmed)) {
      into.commentLine += 1;
      countCommentProse(trimmed.replace(/^[/#\-;\s]+/, ""), into);
      continue;
    }

    // Indentation, from CODE lines only. A JSDoc continuation line is indented
    // one space to align its `*`, and this file has hundreds of them — counting
    // those made a 2-space codebase look like it agreed on no width at all
    // (observed on Golem's own source, 2026-09-13).
    const lead = /^[ \t]*/.exec(line)?.[0] ?? "";
    if (lead.includes("\t")) {
      into.indentTabs += 1;
    } else if (lead.length > 0) {
      into.indentSpaces += 1;
      // Every width the indent divides into gets a vote. A 4-space file votes
      // for 4 AND for 2; a 3-space file votes only for 3. The renderer then
      // takes the LARGEST width that nearly every line agrees on, which is the
      // only reading that tells 4-space apart from 2-space.
      for (const w of [2, 3, 4, 8]) {
        if (lead.length % w === 0) into.indentWidths[w] = (into.indentWidths[w] ?? 0) + 1;
      }
    }

    // Quote habit, counted on code lines only — prose inside comments must not
    // get a vote on whether the user writes 'x' or "x".
    into.quoteSingle += (line.match(/'/g) ?? []).length;
    into.quoteDouble += (line.match(/"/g) ?? []).length;
    into.quoteBacktick += (line.match(/`/g) ?? []).length;

    // A terminator candidate is a code line where ending in a semicolon or not
    // was a genuine style choice. That excludes lines ending in an opener or a
    // comma, and ALSO lines that are nothing but closing delimiters: a bare `}`
    // can never take one, and counting it drags every file toward 50% — while
    // counting `};` but not `}` would bias the other way, so both are dropped.
    if (!/[{([,:]$/.test(trimmed) && !/^[})\]]+[;,]?$/.test(trimmed)) {
      into.terminatorCandidates += 1;
      if (trimmed.endsWith(";")) into.semicolonLines += 1;
    }

    DECL.lastIndex = 0;
    let m: RegExpExecArray | null = DECL.exec(line);
    while (m !== null) {
      if (m[1] !== undefined) classifyIdentifier(m[1], into);
      m = DECL.exec(line);
    }
  }
  return into;
}

/** Merge two observations. Counters sum; `widthMax` takes the larger. */
export function mergeObservations(a: StyleObservation, b: StyleObservation): StyleObservation {
  const out: StyleObservation = { ...a, indentWidths: { ...a.indentWidths } };
  const asRecord = out as unknown as Record<string, number>;
  for (const [key, value] of Object.entries(b)) {
    if (key === "indentWidths") continue;
    if (key === "widthMax") {
      out.widthMax = Math.max(a.widthMax, b.widthMax);
      continue;
    }
    asRecord[key] = ((a as unknown as Record<string, number>)[key] ?? 0) + (value as number);
  }
  for (const [w, n] of Object.entries(b.indentWidths)) {
    out.indentWidths[Number(w)] = (out.indentWidths[Number(w)] ?? 0) + n;
  }
  return out;
}

const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 100));

/** The largest indent width nearly every indented line agrees on, if any. */
export function dominantIndentWidth(o: StyleObservation): number | null {
  const agreed = Object.entries(o.indentWidths)
    .filter(([, n]) => o.indentSpaces > 0 && n >= o.indentSpaces * 0.9)
    .map(([w]) => Number(w))
    .sort((a, b) => b - a);
  return agreed[0] ?? null;
}

/**
 * Render the measured facts as a guideline page.
 *
 * Every row carries its evidence, because a reader has to be able to tell a
 * strong signal ("98% of 4,100 lines") from a coincidence ("60% of 12").
 */
export function renderFormattingGuideline(o: StyleObservation, when: string): string {
  const indentTotal = o.indentTabs + o.indentSpaces;
  const usesTabs = o.indentTabs > o.indentSpaces;
  const width = dominantIndentWidth(o);
  const indentCell = usesTabs
    ? `tabs (${pct(o.indentTabs, indentTotal)}% of ${indentTotal} indented lines)`
    : `spaces (${pct(o.indentSpaces, indentTotal)}% of ${indentTotal} indented lines)${
        width === null ? "" : `, width ${width}`
      }`;
  const commentShape =
    o.commentsCounted === 0
      ? "no comments seen"
      : `${pct(o.commentCapitalStart, o.commentsCounted)}% start capitalised, ` +
        `${pct(o.commentEndsPeriod, o.commentsCounted)}% end in punctuation, ` +
        `${Math.round(o.commentWords / Math.max(1, o.commentsCounted))} words on average`;

  return [
    "# Formatting — measured",
    "",
    `Counted from ${o.files} file(s) and ${o.lines} non-blank lines, on ${when}.`,
    "These are line-level measurements, not a parse. Read a low-percentage row as",
    "noise, and treat a project's own committed conventions as outranking all of it.",
    "",
    "| habit | measurement |",
    "|---|---|",
    `| indent | ${indentCell} |`,
    `| quotes | ${o.quoteDouble >= o.quoteSingle ? "double" : "single"} (${o.quoteDouble} double, ${o.quoteSingle} single, ${o.quoteBacktick} backtick) |`,
    `| statement terminator | ${pct(o.semicolonLines, o.terminatorCandidates)}% of ${o.terminatorCandidates} candidate lines end in a semicolon |`,
    `| line width | ${pct(o.widthLe80, o.lines)}% within 80, ${pct(o.widthLe100, o.lines)}% within 100, ${pct(o.widthLe120, o.lines)}% within 120 (longest ${o.widthMax}) |`,
    `| comment density | ${pct(o.commentLine + o.commentBlock, o.lines)}% of lines (${o.commentLine} line, ${o.commentBlock} block) |`,
    `| comment shape | ${commentShape} |`,
    `| file headers | ${pct(o.fileHeaderComment, o.files)}% of files open with a comment |`,
    `| naming | ${o.camelCase} camelCase, ${o.pascalCase} PascalCase, ${o.snakeCase} snake_case, ${o.screamingCase} SCREAMING_CASE declarations |`,
    "",
  ].join("\n");
}
