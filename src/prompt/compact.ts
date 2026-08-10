/**
 * P3a — the CLAUDE.md compaction actuator.
 *
 * R6.4 ships a leanness *check* (`golem bench cost` counts CLAUDE.md's lines
 * against the cost doc's "keep it under 200 lines" tip). This is the actuator
 * for it: a local-model rewrite that makes the file shorter without losing what
 * it instructs.
 *
 * Route: tier 3b (Golem's own rewrite), not tier 2 (install Caveman's
 * `/caveman-compress` and invoke it). Three reasons, recorded because the task
 * doc made choosing part of the work:
 *
 *  1. Caveman's installer drops its *speech skill* plus a session-flag hook into
 *     the agent's skill directory (verification-notes §87), and
 *     `hasExistingBrevityDirective` (`src/pipeline/brevity.ts`) stands down on
 *     any `/caveman/i` mention. Installing theirs to compact one file would
 *     silently switch Golem's own brevity stage off — a collision the task's
 *     hard constraints name explicitly.
 *  2. Tier 2 depends on `golem ext install` (R8.14), which is not built.
 *  3. `src/prompt/` already does local, inspectable, shown-never-sent rewriting
 *     for R5.5, so the seam exists. Cited, nothing copied.
 *
 * Hard constraints, all enforced in code rather than by prompt:
 *
 *  - **Nothing is written over the original here.** This module is pure: it
 *    returns a proposal and a report. The CLI writes a side file, and applying
 *    it is a second, explicit command after a human has read the diff.
 *  - **Code, commands, paths, URLs and identifiers are byte-preserved.** Fenced
 *    blocks are never sent to the model at all; inline protected spans are
 *    masked with opaque sentinels and restored verbatim. Any segment whose
 *    sentinels do not come back intact is discarded and the ORIGINAL segment is
 *    kept — a failed rewrite costs compaction, never fidelity.
 *  - **The saving is never reported without its cost** (Decision 52). Every
 *    result carries a directive-coverage measure computed WITHOUT the model, so
 *    the cost side cannot quietly vanish when Ollama is down, plus an explicit
 *    statement of what was not measured.
 */

import path from "node:path";
import type { ChatMessage, InferenceService, Role } from "../interfaces/inference.js";

/** Where proposals live. Beside the R5.5 style store, under the project's own
 * `.golem/` — never next to the file being compacted, so a half-reviewed
 * proposal cannot be mistaken for the real instruction file. */
export function compactDir(projectDir: string): string {
  return path.join(projectDir, ".golem", "compact");
}

/** Sentinel prefix for a masked protected span. Identifier-shaped on purpose:
 * a small local model rewords punctuation far more readily than a bare word. */
const SENTINEL = "GOLEMKEEP";
const sentinelFor = (n: number): string => `${SENTINEL}${n}`;
/** Case-insensitive on restore — a model that lowercases a sentinel has still
 * pointed at the right span, and the span itself is restored byte-exact. */
const SENTINEL_RE = new RegExp(`${SENTINEL}(\\d+)`, "gi");

/** Spans masked before the prose ever reaches the model, highest priority first. */
const PROTECTED_PATTERNS: readonly RegExp[] = Object.freeze([
  /`[^`\n]+`/g, // inline code
  /\[[^\]\n]*\]\([^)\s]*\)/g, // markdown link (target AND label — labels carry paths)
  /\bhttps?:\/\/[^\s)<>\]]+/g, // bare URL
  /\[\[[^\]\n]+\]\]/g, // wikilink
  /\b[\w@.+-]*(?:[\\/][\w@.+-]+)+\/?/g, // path-ish (a/b, src/x.ts, .claude/rules/…)
  /\b[\w.-]+\.(?:ts|tsx|js|mjs|cjs|json|jsonl|md|py|toml|yaml|yml|lock|sh|ps1)\b/g, // filename
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, // SCREAMING_SNAKE identifier (GOLEM_*, PATHEXT)
  /\$\{?[A-Za-z_][\w]*\}?/g, // shell/env reference
]);

/** One masked span: what it was, and the sentinel that stood in for it. */
interface MaskedSpan {
  readonly id: number;
  readonly text: string;
}

interface MaskResult {
  readonly masked: string;
  readonly spans: readonly MaskedSpan[];
}

/**
 * Replace every protected span in `text` with an opaque sentinel.
 *
 * Deliberately greedy: masking too much only costs compaction ratio, whereas
 * masking too little risks the model rewording a path. `nextId` threads a
 * document-wide counter so sentinels are unique across segments.
 */
export function maskProtected(text: string, nextId = 0): MaskResult {
  const hits: { start: number; end: number }[] = [];
  for (const pattern of PROTECTED_PATTERNS) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      const start = m.index ?? -1;
      if (start < 0 || m[0].length === 0) continue;
      hits.push({ start, end: start + m[0].length });
    }
  }
  // Longest-first at each position, then drop anything overlapping a keeper, so
  // an inline-code span that contains a path is masked once, not twice.
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: { start: number; end: number }[] = [];
  let cursor = -1;
  for (const h of hits) {
    if (h.start < cursor) continue;
    kept.push(h);
    cursor = h.end;
  }

  const spans: MaskedSpan[] = [];
  let out = "";
  let last = 0;
  let id = nextId;
  for (const h of kept) {
    out += text.slice(last, h.start) + sentinelFor(id);
    spans.push({ id, text: text.slice(h.start, h.end) });
    id += 1;
    last = h.end;
  }
  out += text.slice(last);
  return { masked: out, spans };
}

/**
 * Put the protected spans back, byte-exact.
 *
 * Returns null when the model dropped, duplicated or invented a sentinel — the
 * caller then keeps the original segment. This is the check that makes
 * "byte-preserved" a property of the code and not of the prompt.
 */
export function restoreProtected(masked: string, spans: readonly MaskedSpan[]): string | null {
  const byId = new Map(spans.map((s) => [s.id, s.text]));
  const seen = new Set<number>();
  let invalid = false;
  const restored = masked.replace(SENTINEL_RE, (_full, digits: string) => {
    const id = Number.parseInt(digits, 10);
    const span = byId.get(id);
    if (span === undefined || seen.has(id)) {
      invalid = true;
      return "";
    }
    seen.add(id);
    return span;
  });
  if (invalid || seen.size !== spans.length) return null;
  return restored;
}

/** What a segment is, and therefore whether it may be rewritten at all. */
export type SegmentKind = "code" | "heading" | "frontmatter" | "prose";

export interface Segment {
  readonly kind: SegmentKind;
  readonly text: string;
}

/**
 * Split a markdown document into segments.
 *
 * Fenced code, headings and YAML frontmatter are passed through untouched —
 * headings because they are the file's addressable structure, code because the
 * byte-preservation rule is absolute and the cheapest way to honour it is never
 * to send the bytes.
 */
export function segmentMarkdown(doc: string): Segment[] {
  const lines = doc.split("\n");
  const segments: Segment[] = [];
  let buffer: string[] = [];
  let bufferKind: SegmentKind = "prose";

  const flush = (): void => {
    if (buffer.length === 0) return;
    segments.push({ kind: bufferKind, text: buffer.join("\n") });
    buffer = [];
    bufferKind = "prose";
  };

  let i = 0;
  // YAML frontmatter, only when it opens on line 1.
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, idx) => idx > 0 && l.trim() === "---");
    if (close > 0) {
      segments.push({ kind: "frontmatter", text: lines.slice(0, close + 1).join("\n") });
      i = close + 1;
    }
  }

  let fence: string | null = null;
  for (; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (fence !== null) {
      buffer.push(line);
      if (line.trimStart().startsWith(fence)) {
        fence = null;
        flush();
      }
      continue;
    }
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch?.[1] !== undefined) {
      flush();
      fence = fenceMatch[1];
      bufferKind = "code";
      buffer.push(line);
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      flush();
      segments.push({ kind: "heading", text: line });
      continue;
    }
    buffer.push(line);
  }
  // An unterminated fence stays code: better to skip rewriting it than to send it.
  flush();
  return segments;
}

const SYSTEM = [
  "You shorten a project instruction file that is sent to a coding assistant on every request.",
  "",
  "RULES, in priority order:",
  "1. Preserve every instruction, prohibition, constraint and exception. Remove words, never rules.",
  "2. Tokens matching GOLEMKEEP followed by digits are placeholders for code, paths and URLs.",
  "   Copy each one through EXACTLY as written, once, in the same order. Never reword or drop one.",
  "3. Keep the markdown structure: a bullet stays a bullet, a list stays a list, a line that was",
  "   a rule stays its own line. Do not merge separate rules into one sentence.",
  "4. Drop filler, hedging, restatement and motivation-only prose. Prefer fragments to sentences.",
  "5. Add nothing. No new advice, no headings, no commentary, no preamble, no closing remark.",
  "",
  "Output ONLY the rewritten text.",
].join("\n");

function buildMessages(masked: string): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: masked },
  ];
}

/** Strip a chatty model's code fence around the whole answer, if it added one. */
function unwrapFence(text: string): string {
  const m = /^\s*(?:```+|~~~+)[\w-]*\n([\s\S]*?)\n(?:```+|~~~+)\s*$/.exec(text);
  return m?.[1] ?? text;
}

/** Rough token estimate. Same cheap chars/4 the brevity stage uses — this is a
 * report annotation, not a billing figure. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

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

/* ------------------------------------------------------------------------- *
 * The rewrite itself.
 * ------------------------------------------------------------------------- */

export interface CompactDeps {
  readonly inference: InferenceService;
  /** Local role to draft with. `drafter` by default. */
  readonly role?: Role;
}

export interface SegmentOutcome {
  readonly index: number;
  readonly kind: SegmentKind;
  readonly rewritten: boolean;
  /** Why a prose segment was left alone, when it was. */
  readonly reason?: string;
  readonly beforeTokens: number;
  readonly afterTokens: number;
}

export interface CompactResult {
  readonly original: string;
  readonly compacted: string;
  readonly segments: readonly SegmentOutcome[];
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly savedTokens: number;
  readonly savedPercent: number;
  readonly linesBefore: number;
  readonly linesAfter: number;
  /** The COST side — never optional (Decision 52). */
  readonly directives: readonly Directive[];
  readonly directivesPreserved: number;
  /** Segment-level failures and refusals, surfaced rather than swallowed. */
  readonly warnings: readonly string[];
  /** True when the local model could not be reached at all. */
  readonly modelUnavailable: boolean;
}

/** Below this many characters a prose segment is not worth a round trip. */
const MIN_SEGMENT_CHARS = 120;

/**
 * Compact `original`, returning a proposal and the report that must accompany it.
 *
 * Never throws for a model failure: an unreachable model yields the original
 * document back with `modelUnavailable: true`, which is the honest no-op.
 */
export async function compactDocument(original: string, deps: CompactDeps): Promise<CompactResult> {
  const role: Role = deps.role ?? "drafter";
  const segments = segmentMarkdown(original);
  const outcomes: SegmentOutcome[] = [];
  const warnings: string[] = [];
  const pieces: string[] = [];
  let nextId = 0;
  let modelUnavailable = false;

  for (const [index, seg] of segments.entries()) {
    const beforeTokens = estimateTokens(seg.text);
    const keep = (reason?: string): void => {
      pieces.push(seg.text);
      outcomes.push({
        index,
        kind: seg.kind,
        rewritten: false,
        ...(reason !== undefined ? { reason } : {}),
        beforeTokens,
        afterTokens: beforeTokens,
      });
    };

    if (seg.kind !== "prose") {
      keep("preserved verbatim");
      continue;
    }
    if (seg.text.trim().length < MIN_SEGMENT_CHARS) {
      keep("too short to be worth a rewrite");
      continue;
    }
    if (modelUnavailable) {
      keep("local model unavailable");
      continue;
    }

    // A prose segment owns the blank lines that separate it from the heading or
    // fence on either side. The model will not reproduce them, so hold them back
    // and re-attach — otherwise every rewrite silently welds a paragraph to the
    // next heading and the file's shape drifts each time it is run.
    const segLines = seg.text.split("\n");
    let leadCount = 0;
    while (leadCount < segLines.length && (segLines[leadCount] ?? "").trim() === "") leadCount += 1;
    let trailCount = 0;
    while (
      trailCount < segLines.length - leadCount &&
      (segLines[segLines.length - 1 - trailCount] ?? "").trim() === ""
    )
      trailCount += 1;
    const lead = segLines.slice(0, leadCount).join("\n");
    const trail = segLines.slice(segLines.length - trailCount).join("\n");
    const core = segLines.slice(leadCount, segLines.length - trailCount).join("\n");
    const reassemble = (body: string): string =>
      [...(leadCount > 0 ? [lead] : []), body, ...(trailCount > 0 ? [trail] : [])].join("\n");

    const { masked, spans } = maskProtected(core, nextId);
    let raw: string;
    try {
      const res = await deps.inference.chat(role, buildMessages(masked), { temperature: 0.1 });
      raw = unwrapFence(res.text.trim());
    } catch (err) {
      modelUnavailable = true;
      warnings.push(
        `local model unavailable: ${err instanceof Error ? err.message : String(err)} — every remaining segment kept as-is`,
      );
      keep("local model unavailable");
      continue;
    }

    if (raw.length === 0) {
      warnings.push(`segment ${index}: model returned nothing — kept original`);
      keep("model returned an empty rewrite");
      continue;
    }

    const restored = restoreProtected(raw, spans);
    if (restored === null) {
      warnings.push(
        `segment ${index}: protected spans did not survive the rewrite — kept original`,
      );
      keep("protected spans not preserved");
      continue;
    }
    // A rewrite that mentions Caveman would make `hasExistingBrevityDirective`
    // stand down on a file Golem itself produced, silently switching the brevity
    // stage off. Never accept one that introduces the word.
    if (/caveman/i.test(restored) && !/caveman/i.test(seg.text)) {
      warnings.push(
        `segment ${index}: rewrite introduced a brevity-stage collision — kept original`,
      );
      keep("rewrite would collide with the brevity stage");
      continue;
    }
    const rebuilt = reassemble(restored);
    if (rebuilt.length >= seg.text.length) {
      keep("rewrite was not shorter");
      continue;
    }

    nextId += spans.length;
    pieces.push(rebuilt);
    outcomes.push({
      index,
      kind: seg.kind,
      rewritten: true,
      beforeTokens,
      afterTokens: estimateTokens(rebuilt),
    });
  }

  // When nothing was rewritten, hand the original back byte-for-byte rather
  // than a whitespace-normalised copy — a no-op must look like a no-op.
  const anyRewritten = outcomes.some((o) => o.rewritten);
  const compacted = anyRewritten
    ? `${pieces
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trimEnd()}\n`
    : original;
  const tokensBefore = estimateTokens(original);
  const tokensAfter = estimateTokens(compacted);
  const directives = scoreDirectives(original, compacted);
  return {
    original,
    compacted,
    segments: outcomes,
    tokensBefore,
    tokensAfter,
    savedTokens: tokensBefore - tokensAfter,
    savedPercent: tokensBefore === 0 ? 0 : ((tokensBefore - tokensAfter) / tokensBefore) * 100,
    linesBefore: original.split("\n").length,
    linesAfter: compacted.split("\n").length,
    directives,
    directivesPreserved: directives.filter((d) => d.coverage >= COVERAGE_THRESHOLD).length,
    warnings,
    modelUnavailable,
  };
}

/**
 * Render the report. Saving and cost in ONE view, with the unmeasured part
 * named — a compacted file the model follows less reliably is a loss, and
 * nothing here can detect that.
 */
export function renderCompactReport(result: CompactResult, target: string): string {
  const pct = (n: number): string => `${n.toFixed(1)}%`;
  const lines: string[] = [];
  lines.push(`compaction proposal — ${target}\n`);
  lines.push("SAVING");
  lines.push(
    `  tokens   ${result.tokensBefore} → ${result.tokensAfter}  (−${result.savedTokens}, ${pct(result.savedPercent)})`,
  );
  lines.push(`  lines    ${result.linesBefore} → ${result.linesAfter}`);
  const rewritten = result.segments.filter((s) => s.rewritten).length;
  const prose = result.segments.filter((s) => s.kind === "prose").length;
  lines.push(`  segments ${rewritten}/${prose} prose segments rewritten (code/headings untouched)`);

  lines.push("\nCOST");
  const weak = result.directives.filter((d) => d.coverage < COVERAGE_THRESHOLD);
  lines.push(
    `  directives ${result.directivesPreserved}/${result.directives.length} keep ≥${Math.round(COVERAGE_THRESHOLD * 100)}% of their content words`,
  );
  for (const d of weak.slice(0, 8)) {
    const text = d.text.length > 72 ? `${d.text.slice(0, 69)}...` : d.text;
    lines.push(`    ${pct(d.coverage * 100).padStart(6)}  ${text}`);
    if (d.missing.length > 0)
      lines.push(`            dropped: ${d.missing.slice(0, 8).join(", ")}`);
  }
  if (weak.length > 8) lines.push(`    ... and ${weak.length - 8} more`);

  // A long rule can lose a decisive word ("check the docs BEFORE implementing")
  // and still clear the threshold on word count alone. Those never appear above,
  // so list them separately rather than letting a percentage hide them. Found by
  // reading the first real diff this command produced — the percentage said 28/28.
  const partial = result.directives
    .filter((d) => d.coverage >= COVERAGE_THRESHOLD && d.missing.length > 0)
    .sort((a, b) => b.missing.length - a.missing.length);
  if (partial.length > 0) {
    lines.push(`  partial   ${partial.length} directive(s) kept, but missing some words:`);
    for (const d of partial.slice(0, 5)) {
      const text = d.text.length > 56 ? `${d.text.slice(0, 53)}...` : d.text;
      lines.push(`            −${d.missing.slice(0, 6).join(", ")}  in  ${text}`);
    }
    if (partial.length > 5) lines.push(`            ... and ${partial.length - 5} more`);
  }
  lines.push("  NOT measured: whether the assistant follows the shorter file as reliably.");
  lines.push("  Word survival is a weak proxy for that; read the diff before applying.");

  if (result.warnings.length > 0) {
    lines.push("\nWARNINGS");
    for (const w of result.warnings) lines.push(`  ${w}`);
  }
  if (result.modelUnavailable) {
    lines.push("\nThe local model was unreachable — start Ollama and retry (`golem devices`).");
  }
  return `${lines.join("\n")}\n`;
}
