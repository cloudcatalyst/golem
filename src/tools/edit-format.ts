/**
 * R8.7 — the **edit format** as a measured variable, not an assumption.
 *
 * Aider treats "how do you ask a model to express an edit" as an empirical
 * question with a leaderboard behind it, and R8.7's gate says Golem must do the
 * same before it lets any local model touch a file. So the three formats live
 * here side by side, behind one parse signature, and the harness
 * (`edit-bench.ts`) scores them against each other on the same cases:
 *
 *  - **`search-replace`** — Aider's `<<<<<<< SEARCH` / `=======` /
 *    `>>>>>>> REPLACE` block. Cheapest output, and the only format whose
 *    validity Golem can check *before* writing: the search text either occurs
 *    in the file or it does not (see `edit-apply.ts`).
 *  - **`udiff`** — a unified diff. More familiar to models trained on git, but
 *    its `@@ -12,7 +12,9 @@` header is a **lie waiting to happen**: small models
 *    get line numbers and hunk lengths wrong routinely. This parser therefore
 *    discards the header entirely and reconstructs a search/replace pair from
 *    the hunk body (context+`-` lines → search, context+`+` lines → replace), so
 *    a wrong line number cannot corrupt a file — it can only fail to match.
 *  - **`whole`** — the complete new file. Always applies, never ambiguous, and
 *    costs the most output tokens of the three: it is the *control* arm, the one
 *    that shows what the token saving is actually buying.
 *
 * Everything here is pure and never throws. A model reply is untrusted input:
 * a truncated block, a missing marker, a fence inside a fence — each is
 * reported in `problems` and excluded, because a silently dropped edit reads to
 * the caller as "the model chose to change nothing", which is the one failure
 * mode a harness must never produce.
 */

/** How the model was asked to express the edit. */
export type EditFormat = "search-replace" | "udiff" | "whole";

export const EDIT_FORMATS: readonly EditFormat[] = ["search-replace", "udiff", "whole"];

export function isEditFormat(value: string): value is EditFormat {
  return (EDIT_FORMATS as readonly string[]).includes(value);
}

/**
 * One edit the model proposed, normalized out of whatever format produced it.
 *
 * `search === null` means "replace the whole file with `replace`" (the `whole`
 * format, and only it) — distinguished from an empty search string, which would
 * be an insert-at-every-position and is always a parse problem.
 */
export interface ProposedEdit {
  /** Path exactly as the model wrote it — resolved and checked by the caller. */
  readonly path: string;
  /** Text that must occur in the file, or null for a whole-file replacement. */
  readonly search: string | null;
  readonly replace: string;
}

export interface ParsedEditReply {
  readonly edits: readonly ProposedEdit[];
  /** Why a block was rejected. Never empty when a block was dropped. */
  readonly problems: readonly string[];
}

const SEARCH_MARKER = "<<<<<<< SEARCH";
const DIVIDER_MARKER = "=======";
const REPLACE_MARKER = ">>>>>>> REPLACE";

/**
 * The reply-format contract, as a system-prompt fragment.
 *
 * Written for a 7B-class local model: short, one example, and explicit about
 * the two things such a model gets wrong most often — prose around the block,
 * and paraphrasing the search text instead of copying it byte for byte.
 */
export function editFormatInstructions(format: EditFormat): string {
  switch (format) {
    case "search-replace":
      return [
        "Reply with ONE search/replace block per change and NOTHING else — no",
        "explanation, no markdown fences. Each block is exactly five parts:",
        "the file path on its own line, then:",
        "",
        SEARCH_MARKER,
        "the exact existing lines, copied character for character from the file",
        DIVIDER_MARKER,
        "the lines that replace them",
        REPLACE_MARKER,
        "",
        "The SEARCH text must appear in the file EXACTLY as you write it —",
        "same indentation, same spelling. Do not summarise it, do not add or",
        "remove whitespace, and keep it short: just enough lines to be unique.",
      ].join("\n");
    case "udiff":
      return [
        "Reply with a unified diff and NOTHING else — no explanation, no",
        "markdown fences. Use this shape:",
        "",
        "--- path/to/file.ts",
        "+++ path/to/file.ts",
        "@@ ... @@",
        " unchanged context line (leading space)",
        "-line to remove",
        "+line to add",
        " unchanged context line (leading space)",
        "",
        "Every line inside a hunk MUST start with a space, a '-' or a '+'.",
        "Context and removed lines must be copied EXACTLY from the file.",
        "Line numbers are ignored, so write '@@ ... @@' rather than guessing",
        "them, and give enough context lines to locate the change uniquely.",
      ].join("\n");
    case "whole":
      return [
        "Reply with the file path on its own line, then the COMPLETE new",
        "contents of the file in a single fenced code block, and nothing else:",
        "",
        "path/to/file.ts",
        "```",
        "...the entire file, including every line you did not change...",
        "```",
        "",
        "Do not abbreviate. Never write '// rest of file unchanged' — the",
        "output replaces the file verbatim, so anything you omit is deleted.",
      ].join("\n");
  }
}

/** CRLF is a matching hazard, not an edit: normalize before comparing. */
function normalizeEol(text: string): string {
  return text.replace(/\r\n/gu, "\n");
}

/**
 * A path a model wrote on a line of its own. Kept deliberately permissive
 * (small models add backticks, quotes, "File: " prefixes and trailing colons)
 * but never so permissive that a sentence of prose passes as a path.
 */
function asPathLine(line: string): string | null {
  const cleaned = line
    .trim()
    .replace(/^(?:file|path)\s*:\s*/iu, "")
    .replace(/^[`"'*]+|[`"'*:,]+$/gu, "")
    .trim();
  if (cleaned.length === 0 || cleaned.length > 200) return null;
  if (/\s/u.test(cleaned)) return null;
  if (!/[./\\]/u.test(cleaned)) return null;
  return cleaned.replace(/^\.\//u, "");
}

/** Walk back from a marker to the nearest preceding line that reads as a path. */
function pathBefore(lines: readonly string[], markerIndex: number): string | null {
  for (let i = markerIndex - 1; i >= 0 && i >= markerIndex - 4; i -= 1) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.trim() === "" || /^```/u.test(line.trim())) continue;
    return asPathLine(line);
  }
  return null;
}

function parseSearchReplace(reply: string): ParsedEditReply {
  const lines = normalizeEol(reply).split("\n");
  const edits: ProposedEdit[] = [];
  const problems: string[] = [];

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || !line.trimEnd().startsWith(SEARCH_MARKER)) {
      index += 1;
      continue;
    }
    const path = pathBefore(lines, index);
    const search: string[] = [];
    const replace: string[] = [];
    let cursor = index + 1;
    let sawDivider = false;
    let sawEnd = false;
    for (; cursor < lines.length; cursor += 1) {
      const body = lines[cursor];
      if (body === undefined) continue;
      const trimmed = body.trimEnd();
      if (!sawDivider && trimmed.startsWith(DIVIDER_MARKER)) {
        sawDivider = true;
        continue;
      }
      if (trimmed.startsWith(REPLACE_MARKER)) {
        sawEnd = true;
        break;
      }
      if (trimmed.startsWith(SEARCH_MARKER)) break; // next block started: this one is truncated
      (sawDivider ? replace : search).push(body);
    }

    if (!sawDivider || !sawEnd) {
      problems.push(
        `truncated search/replace block at line ${index + 1} (missing ${
          sawDivider ? REPLACE_MARKER : DIVIDER_MARKER
        })`,
      );
    } else if (path === null) {
      problems.push(`search/replace block at line ${index + 1} has no file path before it`);
    } else if (search.join("\n").trim() === "") {
      problems.push(`empty SEARCH text for ${path} — an empty search matches everywhere`);
    } else {
      edits.push({ path, search: search.join("\n"), replace: replace.join("\n") });
    }
    index = sawEnd ? cursor + 1 : cursor;
  }

  if (edits.length === 0 && problems.length === 0) {
    problems.push(`no ${SEARCH_MARKER} block in the reply`);
  }
  return { edits, problems };
}

const HUNK_HEADER = /^@@.*@@/u;

/**
 * Unified diff → search/replace pairs, with the `@@` header discarded.
 *
 * The header is where a small model's arithmetic fails, and trusting it is how
 * a diff applier corrupts a file at the wrong offset. Reconstructing the two
 * sides from the hunk body makes a bad hunk *unmatchable* instead of dangerous.
 */
function parseUdiff(reply: string): ParsedEditReply {
  const lines = normalizeEol(reply).split("\n");
  const edits: ProposedEdit[] = [];
  const problems: string[] = [];

  let currentPath: string | null = null;
  let search: string[] | null = null;
  let replace: string[] = [];

  const flush = (headerLine: number): void => {
    if (search === null) return;
    if (currentPath === null) {
      problems.push(`hunk at line ${headerLine} has no --- / +++ file header`);
    } else if (search.length === 0 && replace.length === 0) {
      problems.push(`empty hunk for ${currentPath}`);
    } else if (search.length === 0) {
      problems.push(
        `hunk for ${currentPath} has no context or removed lines — nothing to locate it by`,
      );
    } else {
      edits.push({ path: currentPath, search: search.join("\n"), replace: replace.join("\n") });
    }
    search = null;
    replace = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      flush(i + 1);
      const candidate = asPathLine(line.slice(4).replace(/^[ab]\//u, ""));
      if (candidate !== null && candidate !== "/dev/null") currentPath = candidate;
      continue;
    }
    if (HUNK_HEADER.test(line)) {
      flush(i + 1);
      search = [];
      replace = [];
      continue;
    }
    if (search === null) continue; // prose outside any hunk
    if (line.startsWith("+")) {
      replace.push(line.slice(1));
    } else if (line.startsWith("-")) {
      search.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      search.push(line.slice(1));
      replace.push(line.slice(1));
    } else if (line.trim() === "") {
      // A bare empty line inside a hunk is almost always a stripped leading
      // space, not the end of the hunk. Treat it as blank context.
      search.push("");
      replace.push("");
    } else if (line.startsWith("```")) {
      flush(i + 1);
    } else {
      problems.push(`line ${i + 1} inside a hunk starts with neither space, '-' nor '+'`);
      flush(i + 1);
    }
  }
  flush(lines.length);

  if (edits.length === 0 && problems.length === 0) problems.push("no diff hunk in the reply");
  return { edits, problems };
}

/**
 * Whole-file reply: a path, then one fenced block holding the new contents.
 *
 * Falls back to "the whole reply is the file" only when there is no fence at
 * all AND a path line was found — a model that answers with bare code is
 * usable, but a model that answers with prose must not have that prose written
 * to disk.
 */
function parseWhole(reply: string): ParsedEditReply {
  const text = normalizeEol(reply);
  const lines = text.split("\n");
  const problems: string[] = [];
  const edits: ProposedEdit[] = [];

  let path: string | null = null;
  let fenceStart = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    if (/^\s*```/u.test(line)) {
      fenceStart = i;
      break;
    }
    const candidate = asPathLine(line);
    if (candidate !== null) path = candidate;
  }

  if (fenceStart === -1) {
    if (path === null)
      return { edits, problems: ["no fenced block and no file path in the reply"] };
    const body = lines.filter((l) => asPathLine(l) !== path).join("\n");
    if (body.trim() === "") return { edits, problems: [`empty file body for ${path}`] };
    return { edits: [{ path, search: null, replace: `${body.replace(/\n+$/u, "")}\n` }], problems };
  }

  let fenceEnd = -1;
  for (let i = fenceStart + 1; i < lines.length; i += 1) {
    if (/^\s*```\s*$/u.test(lines[i] ?? "")) {
      fenceEnd = i;
      break;
    }
  }
  if (fenceEnd === -1) {
    // Unterminated fence: the reply was cut off, so the "file" is a fragment.
    // Writing it would truncate the real file — refuse.
    return { edits, problems: ["unterminated code fence — the reply looks truncated"] };
  }
  if (path === null) return { edits, problems: ["fenced block has no file path before it"] };
  const body = lines.slice(fenceStart + 1, fenceEnd).join("\n");
  if (body.trim() === "") return { edits, problems: [`empty file body for ${path}`] };
  return { edits: [{ path, search: null, replace: `${body.replace(/\n+$/u, "")}\n` }], problems };
}

/** Parse an untrusted model reply. Never throws; drops nothing silently. */
export function parseEditReply(format: EditFormat, reply: string): ParsedEditReply {
  switch (format) {
    case "search-replace":
      return parseSearchReplace(reply);
    case "udiff":
      return parseUdiff(reply);
    case "whole":
      return parseWhole(reply);
  }
}
