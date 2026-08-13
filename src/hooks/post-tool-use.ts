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
 *
 * ## Layout
 * This module is the hook plumbing: payload schema, text-slot discovery, and
 * the handler. The two payload transforms live beside it and are re-exported
 * here so every existing importer is unaffected:
 *   - `./post-tool-use/digest.js` — the head/tail digest (pure compaction)
 *   - `./post-tool-use/served-fetch-label.js` — the served-WebFetch receipt
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { CcrStore, estimateTokens, LocalDirBlobStore } from "../compression/index.js";
import { type HookIo, readAll } from "./hook-io.js";
import { buildDigest, buildReadSkeleton } from "./post-tool-use/digest.js";
import { servedFetchLabel } from "./post-tool-use/served-fetch-label.js";
import { pipelineRedact, type RedactFn, stripKnownSecrets } from "./redact.js";

export {
  buildDigest,
  DIGEST_HEAD_CHARS,
  DIGEST_TAIL_CHARS,
  SKELETON_CHARS,
  stripReadLineNumbers,
} from "./post-tool-use/digest.js";
export {
  type ServedFetchLabel,
  servedFetchLabel,
} from "./post-tool-use/served-fetch-label.js";
export type { HookIo };

export const HOOK_EVENT_NAME = "PostToolUse";

/** Default inline-size threshold in characters (see module doc for rationale). */
export const DEFAULT_MAX_INLINE_CHARS = 12_000;

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
