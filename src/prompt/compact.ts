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
import type { InferenceService, Role } from "../interfaces/inference.js";
import { rewriteSegment, type SegmentKind, segmentMarkdown } from "./compact-segment.js";
import { COVERAGE_THRESHOLD, type Directive, scoreDirectives } from "./directive-coverage.js";

/* Re-exported so `./compact.js` stays the one import path for the actuator:
 * every caller, barrel export and test that imported from here before the split
 * keeps working unchanged. */
export {
  maskProtected,
  restoreProtected,
  type Segment,
  type SegmentKind,
  segmentMarkdown,
} from "./compact-segment.js";
export {
  COVERAGE_THRESHOLD,
  type Directive,
  extractDirectives,
  scoreDirectives,
} from "./directive-coverage.js";

/** Where proposals live. Beside the R5.5 style store, under the project's own
 * `.golem/` — never next to the file being compacted, so a half-reviewed
 * proposal cannot be mistaken for the real instruction file. */
export function compactDir(projectDir: string): string {
  return path.join(projectDir, ".golem", "compact");
}

/** Rough token estimate. Same cheap chars/4 the brevity stage uses — this is a
 * report annotation, not a billing figure. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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

    const attempt = await rewriteSegment(seg, index, nextId, deps.inference, role);
    if (!attempt.rewritten) {
      if (attempt.warning !== undefined) warnings.push(attempt.warning);
      if (attempt.modelUnavailable === true) modelUnavailable = true;
      keep(attempt.reason);
      continue;
    }

    nextId += attempt.spanCount;
    pieces.push(attempt.text);
    outcomes.push({
      index,
      kind: seg.kind,
      rewritten: true,
      beforeTokens,
      afterTokens: estimateTokens(attempt.text),
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
