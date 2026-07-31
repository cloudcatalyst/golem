/**
 * R8.7 — **validation is Golem's, not the model's.**
 *
 * The task's hard constraint: an unvalidated apply is a code-corruption path.
 * So nothing a local model emits reaches a file until this module has proved
 * three things about it, in this order:
 *
 *  1. **The search text is located, uniquely.** Zero matches is `no-match`;
 *     two or more is `ambiguous` — never "use the first one", which is how an
 *     applier silently edits the wrong function. Matching is plain string work
 *     (`indexOf`), never a regex, so `$&`, backslashes and brackets in code are
 *     literal.
 *  2. **The result differs from the input.** A search/replace pair whose sides
 *     are identical parses, applies, and does nothing; counting it as success is
 *     how a harness measures 100% and means nothing (`no-change`).
 *  3. **No definition disappeared.** Via the injected `symbolCheck`. This is the
 *     guard for what a parse check cannot see and what the small fixtures in
 *     `edit-cases.ts` cannot show: a whole-file rewrite that parses cleanly and
 *     has quietly dropped an unrelated function, the classic
 *     "// ...rest of the file unchanged" truncation. Off only when the caller
 *     explicitly permits symbol loss, because deleting code is exactly the
 *     reading of an ambiguous instruction that must never happen by default.
 *  4. **The result still parses.** Via the injected `parseCheck` — the
 *     tree-sitter probe in `src/knowledge/tree-sitter-chunker.ts`, injected
 *     rather than imported so this module stays pure and testable. Its
 *     three-way return is respected exactly: `true` → `parse-error`, `false` →
 *     clean, `null` → **unavailable**, reported as `parseChecked: false` and
 *     never as clean.
 *
 * Two deliberate leniencies, both measured rather than assumed:
 *
 *  - **`exact-then-trimmed`.** Small models drop trailing whitespace when they
 *    copy lines. A trailing-space-insensitive retry (line-wise, still requiring
 *    a unique match) recovers those without loosening what gets *written*: the
 *    splice happens on original line boundaries, so every byte outside the
 *    matched span is preserved. The report says how often leniency was needed —
 *    if that number is high, the format is fragile, and that is a finding.
 *  - **CRLF.** Matching normalizes line endings; the output is re-emitted in the
 *    file's own style, because rewriting a whole file's newlines as a side
 *    effect of a three-line edit is a diff nobody asked for.
 *
 * No filesystem access, no throwing. Applying to disk is the caller's act and
 * goes through the autonomy gate (ADR-0002).
 */

import type { ProposedEdit } from "./edit-format.js";

/** How strictly the search text must match the file. */
export type MatchStrategy = "exact" | "exact-then-trimmed";

export type EditStatus =
  | "valid"
  | "no-match"
  | "ambiguous"
  | "no-change"
  | "parse-error"
  | "symbols-lost"
  | "empty-reply";

export interface ValidatedEdit {
  readonly status: EditStatus;
  /**
   * The proposed new file contents. Present for `valid` AND for `parse-error`
   * (so a report can show what was rejected) — a caller must key the decision to
   * write on `status`, never on `after !== null`.
   */
  readonly after: string | null;
  readonly reason: string | null;
  /** Which strategy located the last applied hunk, for the leniency count. */
  readonly matchedBy: MatchStrategy | "whole-file" | null;
  /** False when tree-sitter could not check — NOT the same as "parsed clean". */
  readonly parseChecked: boolean;
  /** How many hunks were located and spliced before this result was returned. */
  readonly hunks: number;
}

export interface ValidateOptions {
  readonly before: string;
  readonly edits: readonly ProposedEdit[];
  /** File extension including the dot, e.g. `.ts` — enables the parse check. */
  readonly ext?: string;
  readonly matchStrategy?: MatchStrategy;
  /** Injected syntax probe: true = broken, false = clean, null = unavailable. */
  readonly parseCheck?: (ext: string, content: string) => Promise<boolean | null>;
  /**
   * Injected top-level-definition lister (null when unavailable).
   *
   * This is the guard for the failure mode a parse check cannot see: a
   * whole-file rewrite that parses perfectly and has quietly dropped a function
   * the instruction never mentioned ("// ...rest of file unchanged"). Losing a
   * definition is treated as a rejection, not a diff.
   */
  readonly symbolCheck?: (ext: string, content: string) => Promise<readonly string[] | null>;
  /**
   * Permit an edit that removes a definition — for the rare case where deleting
   * or renaming one IS the instruction. Off by default: the destructive reading
   * of an ambiguous edit must never be the automatic one.
   */
  readonly allowSymbolLoss?: boolean;
}

function fail(
  status: EditStatus,
  reason: string,
  hunks: number,
  after: string | null = null,
): ValidatedEdit {
  return { status, after, reason, matchedBy: null, parseChecked: false, hunks };
}

/** Count non-overlapping occurrences of `needle` — the uniqueness test. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

interface LineSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * Line-wise trailing-whitespace-insensitive match.
 *
 * Returns the unique matching line span, `null` for no match, or the string
 * `"ambiguous"` when more than one span matches — the caller must distinguish
 * "I could not find it" from "I found it twice"; collapsing those loses the only
 * information that says whether the model or the file is at fault.
 */
export function findTrimmedSpan(
  haystackLines: readonly string[],
  needleLines: readonly string[],
): LineSpan | null | "ambiguous" {
  if (needleLines.length === 0 || needleLines.length > haystackLines.length) return null;
  const hay = haystackLines.map((l) => l.trimEnd());
  const needle = needleLines.map((l) => l.trimEnd());
  let found: LineSpan | null = null;
  for (let i = 0; i + needle.length <= hay.length; i += 1) {
    let ok = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (found !== null) return "ambiguous";
    found = { start: i, end: i + needle.length };
  }
  return found;
}

/**
 * Validate (and compute, never write) the result of applying `edits` in order.
 *
 * Stops at the first hunk that cannot be applied: a partially applied edit is
 * worse than a rejected one, and the caller gets the hunk index in the reason.
 */
export async function validateEdits(opts: ValidateOptions): Promise<ValidatedEdit> {
  if (opts.edits.length === 0) return fail("empty-reply", "the model proposed no edits", 0);

  const crlf = opts.before.includes("\r\n");
  const denormalize = (text: string): string => (crlf ? text.replace(/\n/gu, "\r\n") : text);
  const before = crlf ? opts.before.replace(/\r\n/gu, "\n") : opts.before;
  const strategy = opts.matchStrategy ?? "exact";

  let content = before;
  let matchedBy: MatchStrategy | "whole-file" | null = null;
  let hunks = 0;

  for (const [index, edit] of opts.edits.entries()) {
    const label = opts.edits.length === 1 ? "the edit" : `hunk ${index + 1}`;
    if (edit.search === null) {
      content = edit.replace.replace(/\r\n/gu, "\n");
      matchedBy = "whole-file";
      hunks += 1;
      continue;
    }
    const search = edit.search.replace(/\r\n/gu, "\n");
    if (search.trim() === "") {
      return fail("no-match", `${label} has an empty search text`, hunks);
    }
    const replace = edit.replace.replace(/\r\n/gu, "\n");

    const exact = countOccurrences(content, search);
    if (exact === 1) {
      const at = content.indexOf(search);
      content = content.slice(0, at) + replace + content.slice(at + search.length);
      matchedBy = "exact";
      hunks += 1;
      continue;
    }
    if (exact > 1) {
      return fail(
        "ambiguous",
        `${label}'s search text occurs ${exact} times — it does not identify one place`,
        hunks,
      );
    }
    if (strategy === "exact") {
      return fail("no-match", `${label}'s search text does not occur in the file`, hunks);
    }

    // Leniency, line-wise and still unique-or-refuse.
    const contentLines = content.split("\n");
    const span = findTrimmedSpan(contentLines, search.split("\n"));
    if (span === "ambiguous") {
      return fail(
        "ambiguous",
        `${label}'s search text matches more than one place once trailing whitespace is ignored`,
        hunks,
      );
    }
    if (span === null) {
      return fail(
        "no-match",
        `${label}'s search text does not occur in the file, even ignoring trailing whitespace`,
        hunks,
      );
    }
    content = [
      ...contentLines.slice(0, span.start),
      ...replace.split("\n"),
      ...contentLines.slice(span.end),
    ].join("\n");
    matchedBy = "exact-then-trimmed";
    hunks += 1;
  }

  if (content === before) {
    return fail("no-change", "the edit applied but changed nothing", hunks, denormalize(content));
  }

  const after = denormalize(content);
  if (opts.ext === undefined || opts.parseCheck === undefined) {
    return { status: "valid", after, reason: null, matchedBy, parseChecked: false, hunks };
  }
  let broken: boolean | null;
  try {
    broken = await opts.parseCheck(opts.ext, after);
  } catch {
    broken = null; // a probe failure is "unavailable", never "clean"
  }
  if (broken === true) {
    return {
      status: "parse-error",
      after,
      reason: "the result does not parse — refusing to write it",
      matchedBy,
      parseChecked: true,
      hunks,
    };
  }

  if (opts.symbolCheck !== undefined && opts.allowSymbolLoss !== true) {
    let lost: readonly string[] = [];
    try {
      const [wasThere, stillThere] = await Promise.all([
        opts.symbolCheck(opts.ext, opts.before),
        opts.symbolCheck(opts.ext, after),
      ]);
      if (wasThere !== null && stillThere !== null) {
        const kept = new Set(stillThere);
        lost = wasThere.filter((name) => !kept.has(name));
      }
    } catch {
      lost = []; // unavailable, like the parse probe — never a false accusation
    }
    if (lost.length > 0) {
      return {
        status: "symbols-lost",
        after,
        reason:
          `the result no longer defines ${lost.join(", ")} — refusing an edit that deletes ` +
          "code the instruction did not mention",
        matchedBy,
        parseChecked: broken === false,
        hunks,
      };
    }
  }

  return {
    status: "valid",
    after,
    reason:
      broken === null
        ? "applied, but the syntax check was unavailable (tree-sitter grammars not installed)"
        : null,
    matchedBy,
    parseChecked: broken === false,
    hunks,
  };
}
