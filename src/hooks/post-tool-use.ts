/**
 * PostToolUse hook handler (WS-B task B2, spec Decision 10): when a tool
 * output is oversized, store the original in the project CCR store (A2's
 * store — `<project>/.golem/ccr`) and replace what enters model context with
 * a compact digest via `hookSpecificOutput.updatedToolOutput`.
 *
 * ## Verified I/O contract (docs re-checked 2026-07-04 — verification-notes §20)
 * stdin JSON: `session_id`, `prompt_id`, `transcript_path`, `cwd`,
 * `permission_mode`, `hook_event_name`, `tool_name`, `tool_input`,
 * **`tool_response`** (the output field — NOT `tool_output`). The SHAPE of
 * `tool_response` is undocumented and tool-dependent, so this handler acts
 * only on payloads it understands: a string, or an object with a string
 * `output` / `stdout` / `content` / `text` field. Everything else passes
 * through untouched (silent exit 0).
 *
 * stdout JSON on swap:
 *   `{"hookSpecificOutput": {"hookEventName": "PostToolUse",
 *      "updatedToolOutput": <same shape as tool_response, text replaced>}}`
 * `hookEventName` is REQUIRED inside `hookSpecificOutput`.
 *
 * ## Fail-safe policy
 * A hook must never break the user's session: any parse/store error is
 * reported on stderr and the handler exits 0 WITHOUT stdout, so the original
 * tool output passes through unmodified. (Exit 2 is non-blocking for
 * PostToolUse anyway — the tool already ran.)
 *
 * ## Threshold default: 12,000 chars (~3,000 tokens by A2's estimator)
 * Within the task's 8–16k band because: (a) the digest costs up to ~4.5k
 * chars, so at 12k the worst-case swap still elides a solid majority of the
 * output and the win grows with size; (b) Claude Code itself treats hook
 * output strings over 10k chars as "large" (saved to file + preview), so
 * ~12k aligns with the platform's own notion of oversized; (c) outputs under
 * ~3k tokens are cheap relative to the risk and latency of forcing the model
 * into an `expand` round-trip when the excerpt turns out not to suffice.
 *
 * ## Redaction (hard rule: strip BEFORE storing)
 * The stored original and the digest excerpts are both produced from the
 * redacted text: injected {@link RedactFn} first — defaulting to the real
 * pipeline redaction stage, `pipelineRedact` (T-C3) — then the always-on
 * built-in secret strip (redact.ts). `retrieve()` is byte-identical with the
 * *stored* (redacted) original.
 *
 * The digest marker uses A2's `hash=<sha256>` grammar (CCR_MARKER_RE), and the
 * refId is the sha256 of the stored content, so `expand` retrieves it
 * through the exact same code path as A2's dedup markers.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { extname, join } from "node:path";
import { z } from "zod";
import { CcrStore, estimateTokens, LocalDirBlobStore } from "../compression/index.js";
import { parseLoopbackServeUrl } from "../proxy/loopback-serve.js";
import { pipelineRedact, type RedactFn, stripKnownSecrets } from "./redact.js";

export const HOOK_EVENT_NAME = "PostToolUse";

/** Default inline-size threshold in characters (see module doc for rationale). */
export const DEFAULT_MAX_INLINE_CHARS = 12_000;

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
 * Hook stdin payload (external surface -> zod; verification-notes §20).
 * Unknown fields pass through; everything is optional except `tool_response`
 * so a schema drift degrades to "no modification" rather than a crash.
 */
const payloadSchema = z
  .object({
    session_id: z.string().optional(),
    cwd: z.string().optional(),
    hook_event_name: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.unknown().optional(),
    tool_response: z.unknown(),
  })
  .passthrough();

export type PostToolUsePayload = z.infer<typeof payloadSchema>;

/** Injectable process I/O so tests never touch real stdio. */
export interface HookIo {
  readonly stdin: AsyncIterable<string | Uint8Array>;
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

export interface PostToolUseOptions {
  /** Inline threshold in characters; default {@link DEFAULT_MAX_INLINE_CHARS}. */
  readonly maxInlineChars?: number;
  /**
   * R8.5 — per-project gate for the oversized-`Read` symbol skeleton, read from
   * `knowledge.read_skeleton_enabled` by the CLI layer (this module stays free of
   * a config dependency, like `revalidateEnabled` in web-fetch.ts). Omitted →
   * enabled; a gate that throws is treated as enabled, since the skeleton can
   * only ever add navigation to a digest that is already being written.
   */
  readonly skeletonEnabled?: (projectDir: string) => Promise<boolean>;
  /**
   * Pipeline redaction stage (task T-C3). Defaults to `pipelineRedact` — the
   * full REDACTION_RULES table plus the high-entropy sweep. Runs BEFORE the
   * built-in secret strip, which is always applied on top regardless of what
   * (if anything) is injected here — injection can only strengthen, never
   * weaken, redaction.
   */
  readonly redact?: RedactFn;
  /** CCR store project root override; default: the payload's `cwd`. */
  readonly projectDir?: string;
}

/** Where a swappable text payload lives inside `tool_response`. */
export interface TextSlot {
  readonly text: string;
  rebuild(next: string): unknown;
}

/**
 * `tool_response` keys probed for the dominant text payload, in order. The
 * shape is undocumented (verification-notes §20) — keep this list short and
 * obvious; unknown shapes must pass through untouched.
 *
 * `result` was missing until R9.12, and its absence was silent: WebFetch answers
 * with `{bytes, code, codeText, result, durationMs, url}` (measured), so every
 * WebFetch response failed to match and the oversized-output swap never once
 * fired for that tool. `web-fetch.ts`'s own `textOf()` had listed `result` all
 * along — two lists of the same thing, drifting apart where nothing checked.
 */
const TEXT_KEYS = ["output", "stdout", "content", "text", "result"] as const;

/** Provenance wording for a served WebFetch: one line for the user, more for the model. */
export interface ServedFetchLabel {
  /**
   * Single line for `systemMessage`, the only channel the UI actually shows the
   * user here. A collapsed WebFetch row renders as just `Fetch(url)` — no result
   * line — and the URL it prints is the ORIGINAL input, not our rewrite, so
   * neither the header nor `updatedToolOutput` can carry a visible label.
   */
  readonly line: string;
  /** The fuller receipt that replaces the tool output the model reads. */
  readonly detail: string;
}

/**
 * The provenance label for a WebFetch Golem served, or null when this call is
 * not one of ours (in which case the real fetch's output is left untouched).
 * Pure: everything it needs travels on the rewritten URL.
 */
export function servedFetchLabel(
  toolName: string | undefined,
  toolInput: unknown,
): ServedFetchLabel | null {
  if (toolName !== "WebFetch") return null;
  const input =
    typeof toolInput === "object" && toolInput !== null && !Array.isArray(toolInput)
      ? (toolInput as Record<string, unknown>)
      : null;
  const url = input?.url;
  if (typeof url !== "string") return null;

  const served = parseLoopbackServeUrl(url);
  if (served === null) return null;

  if (served.source === "miss") {
    return {
      line: `Golem: fetched live and cached — ${served.targetUrl}`,
      detail:
        `**Golem** Fetched live from ${served.targetUrl} — now cached.\n` +
        "Golem fetched the raw page itself, so the model received the full page text " +
        "rather than a summary of it.",
    };
  }
  const age = served.age === undefined ? "" : ` (stored ${served.age})`;
  return {
    line: `Golem: served from cache${age} — ${served.targetUrl}`,
    detail:
      `**Golem** Served from cache${age} — ${served.targetUrl}\n` +
      "No network request was made; the page text was delivered to the model directly.",
  };
}

export function findTextSlot(response: unknown): TextSlot | null {
  if (typeof response === "string") {
    return { text: response, rebuild: (next) => next };
  }
  if (typeof response === "object" && response !== null && !Array.isArray(response)) {
    const record = response as Record<string, unknown>;
    for (const key of TEXT_KEYS) {
      const value = record[key];
      if (typeof value === "string") {
        return { text: value, rebuild: (next) => ({ ...record, [key]: next }) };
      }
    }
  }
  return null;
}

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
 * Build the replacement digest. Pure function of its inputs (no clock, no
 * store state) — the same output always produces the same digest.
 * Contains A2's CCR marker (`hash=<64-hex>` — CCR_MARKER_RE) so the model can
 * expand it with the `expand` MCP tool / `/golem/expand`.
 */
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
async function buildReadSkeleton(
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
      import("../knowledge/tree-sitter-chunker.js"),
      import("../knowledge/repo-map.js"),
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

async function readAll(stream: AsyncIterable<string | Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of stream) {
    out += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  }
  return out + decoder.decode();
}

/**
 * Run the PostToolUse hook once: read the payload from `io.stdin`, and either
 * write the `updatedToolOutput` JSON to `io.stdout` (oversized output) or
 * write nothing (everything else). Resolves to the process exit code — always
 * 0; see the fail-safe policy in the module doc.
 */
export async function runPostToolUseHook(
  io: HookIo,
  options: PostToolUseOptions = {},
): Promise<number> {
  const maxInlineChars = options.maxInlineChars ?? DEFAULT_MAX_INLINE_CHARS;

  let payload: PostToolUsePayload;
  try {
    const raw = await readAll(io.stdin);
    const parsed = payloadSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      io.stderr.write(`golem hook post-tool-use: unrecognized payload, passing through\n`);
      return 0;
    }
    payload = parsed.data;
  } catch (err) {
    io.stderr.write(
      `golem hook post-tool-use: could not read hook payload, passing through ` +
        `(${err instanceof Error ? err.message : String(err)})\n`,
    );
    return 0;
  }

  const slot = findTextSlot(payload.tool_response);

  // R9.12: a WebFetch Golem served from its cache actually ran, against a
  // loopback STUB, so what lands in the transcript is the summarizer's paraphrase
  // of that placeholder — accurate but vague, and worded differently every run.
  // Replace it with a deterministic receipt naming the real URL and where the
  // bytes came from. This lives here rather than in the WebFetch post hook
  // because that one is registered `async`, so its stdout is discarded; this hook
  // is the one Claude Code actually reads output substitution from.
  if (slot !== null) {
    const served = servedFetchLabel(payload.tool_name, payload.tool_input);
    if (served !== null) {
      io.stdout.write(
        `${JSON.stringify({
          // `systemMessage` is the ONLY user-visible channel here (docs: "Warning
          // message shown to the user"). A collapsed WebFetch row shows just
          // `Fetch(url)` with no result line, and that URL is the original input
          // rather than our rewrite — so without this the provenance is invisible
          // unless the entry is expanded. `additionalContext`, by contrast,
          // "doesn't appear as a chat message in the interface".
          systemMessage: served.line,
          hookSpecificOutput: {
            hookEventName: HOOK_EVENT_NAME,
            updatedToolOutput: slot.rebuild(served.detail),
          },
        })}\n`,
      );
      return 0;
    }
  }

  if (slot === null || slot.text.length <= maxInlineChars) {
    return 0; // below threshold or shape we don't understand — silent pass-through
  }

  try {
    // Redaction BEFORE storage or excerpting (hard rule): injected pipeline
    // stage first (defaults to pipelineRedact, T-C3), built-in secret strip
    // always on top — this order means injection/default can only strengthen.
    const stored = stripKnownSecrets((options.redact ?? pipelineRedact)(slot.text));
    const refId = createHash("sha256").update(stored, "utf8").digest("hex");

    // R8.5: extracted from the REDACTED text, like the excerpts — the skeleton
    // must never re-introduce something redaction removed.
    const projectDir = options.projectDir ?? payload.cwd ?? process.cwd();
    let skeletonAllowed = true;
    if (options.skeletonEnabled !== undefined) {
      try {
        skeletonAllowed = await options.skeletonEnabled(projectDir);
      } catch {
        skeletonAllowed = true;
      }
    }
    const skeleton = skeletonAllowed
      ? await buildReadSkeleton(payload.tool_name, payload.tool_input, stored)
      : null;

    const digest = buildDigest(
      payload.tool_name,
      stored,
      refId,
      ...(skeleton !== null ? ([skeleton] as const) : ([] as const)),
    );
    if (digest.length >= slot.text.length) {
      return 0; // swap would not pay for itself (tiny custom thresholds only)
    }

    const ccr = new CcrStore(new LocalDirBlobStore(join(projectDir, ".golem", "ccr")));
    await ccr.putIfAbsent(refId, {
      v: 1,
      contentType: "text/plain",
      originalTokens: estimateTokens(stored),
      content: stored,
    });

    io.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: HOOK_EVENT_NAME,
          updatedToolOutput: slot.rebuild(digest),
        },
      })}\n`,
    );
    return 0;
  } catch (err) {
    // Never break the session: report and let the original output through.
    io.stderr.write(
      `golem hook post-tool-use: swap failed, passing original through ` +
        `(${err instanceof Error ? err.message : String(err)})\n`,
    );
    return 0;
  }
}
