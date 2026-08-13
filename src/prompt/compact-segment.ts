/**
 * P3a — everything that is true of ONE segment of a CLAUDE.md document:
 * splitting the file into segments, masking the spans that must survive
 * byte-exact, and the guarded single-segment rewrite. Extracted verbatim from
 * `./compact.js`, which now only orchestrates and reports.
 *
 * This module is the byte-preservation boundary. Fenced code, headings and
 * frontmatter never reach the model at all; inline protected spans are replaced
 * with opaque sentinels and restored verbatim, and {@link rewriteSegment}
 * refuses any rewrite whose sentinels did not come back intact. A failed
 * rewrite costs compaction, never fidelity — so every guard returns the reason
 * to keep the ORIGINAL rather than throwing.
 */

import type { ChatMessage, InferenceService, Role } from "../interfaces/inference.js";

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

/**
 * The verdict on one segment: an accepted replacement, or the reason the
 * ORIGINAL must be kept. Never an exception — a rewrite that cannot be proven
 * safe costs compaction, never fidelity, so every guard below returns
 * `rewritten: false` and the caller keeps the segment it already had.
 */
export type SegmentRewrite =
  | {
      readonly rewritten: true;
      /** The accepted replacement, blank lines re-attached, spans restored. */
      readonly text: string;
      /** How far to advance the document-wide sentinel counter. */
      readonly spanCount: number;
    }
  | {
      readonly rewritten: false;
      /** Why the original was kept — reported per segment. */
      readonly reason: string;
      /** A document-level warning, when this refusal deserves one. */
      readonly warning?: string;
      /** True when the model could not be reached at all, so the caller stops asking. */
      readonly modelUnavailable?: true;
    };

/**
 * Rewrite ONE prose segment, or explain why it was left alone.
 *
 * `nextId` is the document-wide sentinel counter, so sentinels stay unique
 * across segments; the caller advances it by `spanCount` only when the rewrite
 * is accepted. The caller decides *whether* a segment is a candidate (kind,
 * length, whether the model is still reachable); everything from here down is
 * this segment's own business.
 */
export async function rewriteSegment(
  seg: Segment,
  index: number,
  nextId: number,
  inference: InferenceService,
  role: Role,
): Promise<SegmentRewrite> {
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
    const res = await inference.chat(role, buildMessages(masked), { temperature: 0.1 });
    raw = unwrapFence(res.text.trim());
  } catch (err) {
    return {
      rewritten: false,
      reason: "local model unavailable",
      warning: `local model unavailable: ${err instanceof Error ? err.message : String(err)} — every remaining segment kept as-is`,
      modelUnavailable: true,
    };
  }

  if (raw.length === 0) {
    return {
      rewritten: false,
      reason: "model returned an empty rewrite",
      warning: `segment ${index}: model returned nothing — kept original`,
    };
  }

  const restored = restoreProtected(raw, spans);
  if (restored === null) {
    return {
      rewritten: false,
      reason: "protected spans not preserved",
      warning: `segment ${index}: protected spans did not survive the rewrite — kept original`,
    };
  }
  // A rewrite that mentions Caveman would make `hasExistingBrevityDirective`
  // stand down on a file Golem itself produced, silently switching the brevity
  // stage off. Never accept one that introduces the word.
  if (/caveman/i.test(restored) && !/caveman/i.test(seg.text)) {
    return {
      rewritten: false,
      reason: "rewrite would collide with the brevity stage",
      warning: `segment ${index}: rewrite introduced a brevity-stage collision — kept original`,
    };
  }
  const rebuilt = reassemble(restored);
  if (rebuilt.length >= seg.text.length) {
    return { rewritten: false, reason: "rewrite was not shorter" };
  }

  return { rewritten: true, text: rebuilt, spanCount: spans.length };
}
