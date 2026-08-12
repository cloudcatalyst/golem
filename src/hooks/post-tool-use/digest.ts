/**
 * The oversized-output digest: pure string compaction, no I/O and no hook
 * plumbing.
 *
 * Everything here is a deterministic function of its inputs — the digest is
 * content-addressed and must stay byte-stable for a given input (prefix
 * stability, §14). The emitted text is a CONTRACT: the `hash=<64-hex>` marker
 * grammar (A2's CCR_MARKER_RE) and the surrounding phrasing are what the
 * `expand` MCP tool and `.claude/rules/golem-ccr-refs.md` promise the model, so
 * the wording is pinned by tests and must not drift.
 *
 * The one exception to "no I/O" is {@link buildReadSkeleton}, which lazily
 * imports the tree-sitter extractor — a no-op returning null whenever that tier
 * is absent, so the digest never depends on it.
 */

import { Buffer } from "node:buffer";
import { extname } from "node:path";
import { estimateTokens } from "../../compression/index.js";

/**
 * Digest excerpt budgets. Head is bigger than tail: most tool outputs
 * front-load the signal (command echo, first error, file preamble) while the
 * tail catches summaries/exit lines. Total digest stays ≤ ~4.5k chars so the
 * hook's JSON stdout sits well under Claude Code's 10k-char hook-output cap
 * (verification-notes §20).
 */
export const DIGEST_HEAD_CHARS = 2_400;
export const DIGEST_TAIL_CHARS = 1_200;
/**
 * R8.5 — char budget for the symbol skeleton added to an oversized `Read`.
 * Sized so head + tail + skeleton stays under Claude Code's 10k-char hook-output
 * cap (§20) with room for the JSON envelope, and so the skeleton is a small
 * fraction of what it makes recoverable: ~1.5k chars buys every definition in a
 * typical 1,000-line module with its line number.
 */
export const SKELETON_CHARS = 1_500;

/**
 * R8.3 — line-aligned excerpts that say WHICH lines they are.
 *
 * These replace the original char-window excerpts (`text.slice(0, max)` nudged to
 * the nearest newline), which were cheap but **positionless**: the model got text
 * with no idea which lines it held, so the only way to see more was `expand`, which
 * re-enters the whole original. §95 measured one `expand` call at **6,356 tokens** —
 * the fourth-largest tool consumer in a real session, from a single result — while
 * §95's `Read` bucket (27,056 tokens across 18 results) is exactly the surface an
 * external Bash compactor cannot reach (§90).
 *
 * Naming the ranges makes the cheap recovery obvious: re-read lines 43–120, or
 * grep the file, instead of pulling back 15k tokens. That is what
 * `.claude/rules/golem-ccr-refs.md` already tells agents to prefer; this makes the
 * digest support the advice instead of quietly working against it.
 *
 * Pure and deterministic — the digest is content-addressed and must stay
 * byte-stable for a given input (prefix stability, §14).
 */
interface LineRange {
  readonly text: string;
  /** 1-based inclusive line numbers the excerpt covers. */
  readonly firstLine: number;
  readonly lastLine: number;
  /**
   * True when the char budget cut inside a line, so the range is only partly
   * shown. Minified bundles and JSON blobs are one enormous line — line
   * alignment must never let such an input through un-truncated, which is
   * exactly what the first draft of this did.
   */
  readonly truncated: boolean;
}

/** Leading whole lines that fit in `maxChars` (always at least one, char-capped). */
function headLines(lines: readonly string[], maxChars: number): LineRange {
  let used = 0;
  let count = 0;
  for (const line of lines) {
    const next = used + line.length + 1;
    if (count > 0 && next > maxChars) break;
    used = next;
    count += 1;
  }
  const joined = lines.slice(0, count).join("\n");
  const text = joined.length > maxChars ? joined.slice(0, maxChars) : joined;
  return { text, firstLine: 1, lastLine: count, truncated: text.length < joined.length };
}

/** Trailing whole lines that fit in `maxChars` (always at least one, char-capped). */
function tailLines(lines: readonly string[], maxChars: number): LineRange {
  let used = 0;
  let count = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] as string;
    const next = used + line.length + 1;
    if (count > 0 && next > maxChars) break;
    used = next;
    count += 1;
  }
  const joined = lines.slice(lines.length - count).join("\n");
  const text = joined.length > maxChars ? joined.slice(-maxChars) : joined;
  return {
    text,
    firstLine: lines.length - count + 1,
    lastLine: lines.length,
    truncated: text.length < joined.length,
  };
}

/**
 * R8.12 — an external compactor's own recovery pointer, if the output carries one.
 *
 * RTK (spec Decision 53 tier-3a peer) tees the full unfiltered output to a file on
 * failure and points at it inline: `[full output: ~/.local/share/rtk/tee/….log]`.
 * If Golem then swaps that output for a head/tail excerpt, the pointer can land in
 * the elided middle — so a compaction *of a compaction* silently destroys the other
 * tool's way back to the original. Cheap to prevent: find the line and carry it.
 *
 * Matched loosely (any `[full output: …]` line) because the exact wording belongs
 * to another project and may change; a false positive costs one preserved line.
 */
const EXTERNAL_RECOVERY_RE = /^.*\[full output:[^\]]+\].*$/m;

function externalRecoveryPointer(text: string): string | null {
  const match = EXTERNAL_RECOVERY_RE.exec(text);
  return match === null ? null : match[0].trim();
}

/**
 * R8.5 — an oversized `Read` also gets the file's SYMBOL SKELETON.
 *
 * The head/tail excerpt tells the model what the file starts and ends with; the
 * skeleton tells it what is in the elided middle and, crucially, on which line.
 * That converts the recovery path from `expand` (re-enters the whole original —
 * §95 measured one at 6,356 tokens) into a `Read` of forty lines. It is the
 * cheapest half of the repo map: the same tree-sitter extractor, one file, no
 * graph.
 *
 * Not a product surface of its own — per-file signature extraction is RTK's
 * `read -l aggressive` (out of scope by the R8 memo); this is the swap target
 * the map task asked for.
 */
const READ_LINE_RE = /^\s*(\d+)\t(.*)$/u;

/**
 * Strip Claude Code's `cat -n`-style `<line>\t<text>` prefixes from a `Read`
 * output, returning the bare source plus the first line number it covered (a
 * `Read` with an `offset` does not start at 1, and the skeleton's line numbers
 * must be the FILE's, not the excerpt's). Null when the payload does not look
 * like a numbered read — then no skeleton is attempted.
 */
export function stripReadLineNumbers(
  text: string,
): { readonly content: string; readonly firstLine: number } | null {
  const lines = text.split("\n");
  let sampled = 0;
  let matched = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    sampled += 1;
    if (READ_LINE_RE.test(line)) matched += 1;
    if (sampled >= 20) break;
  }
  if (sampled === 0 || matched / sampled < 0.8) return null;

  const out: string[] = [];
  let firstLine: number | null = null;
  for (const line of lines) {
    const match = READ_LINE_RE.exec(line);
    if (match === null) {
      out.push(line);
      continue;
    }
    if (firstLine === null) firstLine = Number.parseInt(match[1] as string, 10);
    out.push(match[2] as string);
  }
  if (firstLine === null || !Number.isFinite(firstLine)) return null;
  return { content: out.join("\n"), firstLine };
}

function readFilePath(toolInput: unknown): string | null {
  if (typeof toolInput !== "object" || toolInput === null) return null;
  const value = (toolInput as { file_path?: unknown }).file_path;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The skeleton section for an oversized `Read`, or null (wrong tool, no
 * `file_path`, no grammar for the extension, tree-sitter absent, parse failure,
 * or nothing worth listing). Every one of those is a no-op, never an error:
 * the digest is written either way.
 *
 * tree-sitter is imported lazily so a hook process that is not swapping a `Read`
 * never pays the WASM load.
 */
export async function buildReadSkeleton(
  toolName: string | undefined,
  toolInput: unknown,
  text: string,
): Promise<string | null> {
  if (toolName !== "Read") return null;
  const filePath = readFilePath(toolInput);
  if (filePath === null) return null;
  const ext = extname(filePath).toLowerCase();

  try {
    const [{ extractFileFacts, isSymbolExtractable }, { renderFileSkeleton }] = await Promise.all([
      import("../../knowledge/tree-sitter-chunker.js"),
      import("../../knowledge/repo-map.js"),
    ]);
    if (!isSymbolExtractable(ext)) return null;
    const stripped = stripReadLineNumbers(text);
    if (stripped === null) return null;
    const facts = await extractFileFacts(ext, stripped.content);
    if (facts === null || facts.defs.length === 0) return null;
    const offset = stripped.firstLine - 1;
    const shifted = facts.defs.map((def) => ({ ...def, line: def.line + offset }));
    const skeleton = renderFileSkeleton(shifted, SKELETON_CHARS);
    if (skeleton.shown === 0) return null;
    const of = skeleton.hidden > 0 ? ` of ${shifted.length}` : "";
    return (
      `--- symbol skeleton: ${skeleton.shown}${of} definition(s) with their line numbers ` +
      `(Read one of these ranges instead of expanding) ---\n${skeleton.text}\n`
    );
  } catch {
    return null; // tier-2 absence or any parse trouble — the digest stands alone
  }
}

/**
 * Build the replacement digest. Pure function of its inputs (no clock, no
 * store state) — the same output always produces the same digest.
 * Contains A2's CCR marker (`hash=<64-hex>` — CCR_MARKER_RE) so the model can
 * expand it with the `expand` MCP tool / `/golem/expand`.
 */
export function buildDigest(
  toolName: string | undefined,
  text: string,
  refId: string,
  skeleton?: string,
): string {
  const bytes = Buffer.byteLength(text, "utf8");
  const allLines = text.split("\n");
  const lines = allLines.length;
  const tokens = estimateTokens(text);
  const head = headLines(allLines, DIGEST_HEAD_CHARS);
  const tail = tailLines(allLines, DIGEST_TAIL_CHARS);

  // Overlapping excerpts mean the whole thing fits — emit it once rather than
  // twice, and say so, instead of implying content was elided. Both conditions
  // are required: line coverage AND no char-level truncation, or a single
  // enormous line would be declared "complete" and pass through whole.
  const complete = head.lastLine >= tail.firstLine - 1 && !head.truncated && !tail.truncated;
  const elidedFrom = head.lastLine + 1;
  const elidedTo = tail.firstLine - 1;
  const elidedCount = complete ? 0 : Math.max(0, elidedTo - elidedFrom + 1);

  const external = externalRecoveryPointer(text);
  const preserved =
    external !== null && !head.text.includes(external) && !tail.text.includes(external)
      ? `--- preserved pointer from an external compactor ---\n${external}\n`
      : "";

  const partly = (range: LineRange): string => (range.truncated ? ", partial" : "");
  const body = complete
    ? `--- lines 1-${lines} of ${lines} ---\n${text}\n`
    : `--- head: lines ${head.firstLine}-${head.lastLine} of ${lines}${partly(head)} ---\n` +
      `${head.text}\n` +
      `--- tail: lines ${tail.firstLine}-${tail.lastLine} of ${lines}${partly(tail)} ---\n` +
      `${tail.text}\n`;

  // R8.3: name the elided range and point at the CHEAP recovery first. Expanding
  // re-enters the full original and costs back what the swap saved (§95 measured
  // one expand at ~6.4k tokens), so a narrower re-read is almost always better.
  const elided =
    elidedCount > 0
      ? `${elidedCount} line(s) elided (lines ${elidedFrom}-${elidedTo})`
      : "content elided mid-line";
  const skeletonSection = skeleton !== undefined && !complete ? skeleton : "";
  const viaSkeleton =
    skeletonSection.length > 0 ? "the skeleton above names every definition and its line, so " : "";
  const recovery = complete
    ? `--- end of excerpt: full output above. Retrieve original: expand MCP tool with ` +
      `ref_id "${refId}" (or /golem/expand ${refId}) ---`
    : `--- ${elided}. PREFER a narrower re-read of just what you need (${viaSkeleton}Read with ` +
      `offset/limit, or grep the file) — expanding re-enters the FULL original and costs ` +
      `back the tokens this swap saved. To expand anyway: expand MCP tool with ` +
      `ref_id "${refId}" (or /golem/expand ${refId}) ---`;

  return (
    `[Golem: oversized ${toolName ?? "tool"} output (${bytes} bytes, ${lines} lines, ` +
    `~${tokens} tokens) swapped for a head/tail excerpt. The full original is stored ` +
    `losslessly. Retrieve original: hash=${refId}]\n` +
    skeletonSection +
    body +
    preserved +
    recovery
  );
}
