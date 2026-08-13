/**
 * Serving a page back to Claude from the PreToolUse(WebFetch) hook (R9.12).
 *
 * There are two shapes, one body. Which one is used is decided ONCE per call by
 * {@link greenServeState}, and it fails closed — a session with no loopback
 * endpoint, or one whose `NODE_EXTRA_CA_CERTS` is not ours, is byte-identical to
 * what R9.7 shipped:
 *
 *   green — `allow` + `updatedInput` pointing at a loopback STUB, with the raw
 *           cached page carried in `additionalContext`. §122 measured that
 *           `additionalContext` reaches the model on an `allow`, and reaches it
 *           even when the rewritten call fails, so content delivery does not
 *           depend on the fetch succeeding. Serving a stub rather than the page
 *           keeps WebFetch's summarizer off the content, preserving Decision 42.
 *   floor — the `deny` R9.7 shipped, byte for byte. Used whenever the endpoint is
 *           absent, the certificate is not trusted in THIS process, or anything
 *           else is unclear. Never worse than what shipped.
 *
 * The exact stdout JSON of both shapes is parsed strictly by Claude Code and is
 * pinned by tests; treat it as a contract, not as formatting.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CcrStore, estimateTokens, LocalDirBlobStore } from "../../compression/index.js";
import { findDraftByUrl, type WebCacheEntry } from "../../knowledge/index.js";
import {
  decideReach,
  readLoopbackHits,
  readLoopbackReach,
  writeLoopbackReach,
} from "../../proxy/loopback-reach.js";
import {
  type LoopbackServeState,
  loopbackServeUrl,
  probeLoopbackServe,
  readLoopbackServeState,
  type ServeSource,
} from "../../proxy/loopback-serve.js";
import type { HookIo } from "../hook-io.js";
import { stripKnownSecrets } from "../redact.js";

/**
 * Opening frame for a served page. A serve is a `deny` (the only PreToolUse
 * shape that returns content without running the tool — §115/§120), and Claude
 * Code renders a denied call as an error. The old intro opened with a bare `✓`,
 * which read as a tick inside an `<error>` box; this says plainly what happened
 * so neither Claude nor a human reading the transcript mistakes it for a failure.
 */
const NOT_AN_ERROR = "NOT AN ERROR —";
/** Closing frame: why the call renders red, then the content. */
const RED_DOT_NOTE =
  "Claude Code renders hook-served content as a *denied* tool call, so this shows as a failed/red WebFetch; that is expected and the fetch did not fail. Content follows:";
/**
 * Closing frame for the GREEN path (R9.12). The tool really ran, against Golem's
 * loopback stub, so the tool result the model sees is a placeholder — this says
 * so, and points at the real content that follows in `additionalContext`.
 */
const GREEN_NOTE =
  "The WebFetch call SUCCEEDED — its tool result is a short Golem placeholder rather than the page, and the real page content follows here. Do not describe the fetch as failed and do not retry it. Content:";

/** Cap on cached content echoed in a deny reason (Claude Code flags hook output >10k chars). */
export const MAX_SERVED_CHARS = 8_000;

function humanAge(fetchedAt: string, nowMs: number): string {
  const ms = nowMs - Date.parse(fetchedAt);
  if (!Number.isFinite(ms) || ms < 0) return "recently";
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return "under an hour ago";
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Store an oversized served page in the project CCR store so the full text is
 * retrievable in one deterministic step via the `expand` MCP tool — the same
 * content-addressed store and `hash=<sha256>` marker grammar the oversized
 * tool-output swap uses (post-tool-use.ts), so `expand` resolves it through the
 * exact same path. Redaction is re-applied at the storage point (hard rule);
 * both serve paths already hand us redacted content, so `stripKnownSecrets` is
 * idempotent here and the refId matches what post-tool-use would compute.
 * Best-effort: returns the refId on success, or null on ANY failure — a CCR
 * error must never break the hook (the caller falls back to a KB-search hint).
 */
async function storeServedPageRef(projectDir: string, content: string): Promise<string | null> {
  try {
    const stored = stripKnownSecrets(content);
    const refId = createHash("sha256").update(stored, "utf8").digest("hex");
    const ccr = new CcrStore(new LocalDirBlobStore(join(projectDir, ".golem", "ccr")));
    await ccr.putIfAbsent(refId, {
      v: 1,
      contentType: "text/plain",
      originalTokens: estimateTokens(stored),
      content: stored,
    });
    return refId;
  } catch {
    return null; // best-effort: caller falls back to the KB-search hint
  }
}

/** R9.19 — injection points for the reachability latch (tests supply a clock). */
export interface GreenServeOptions {
  readonly nowMs?: number;
  /** Where the latch's stderr note goes; omitted → silent. */
  readonly stderr?: { write(s: string): void };
}

/**
 * Whether the GREEN path is available *for the session actually running* — the
 * positive evidence §121-B demanded instead of assuming. Four conditions, all
 * cheap, all failing closed to the deny path:
 *
 * 1. A loopback endpoint has published its coordinates (the proxy daemon is up).
 * 2. `NODE_EXTRA_CA_CERTS` — which the hook inherits from Claude Code, so it IS
 *    what Claude Code was started with — points at *our* certificate. If it is
 *    unset (no restart yet) or owned by someone else (a TLS-inspection proxy,
 *    §121-C), we must not rewrite.
 * 3. The endpoint answers a TLS probe validated against that same certificate.
 * 4. **R9.19** — no evidence that a previous rewrite in this window went
 *    unfollowed. Signals 1–3 all read this process's own environment, and §125
 *    measured that a hook's environment reflects the settings FILE rather than what
 *    Claude Code's TLS stack honours; §121-A records that the two disagree in cloud
 *    and Desktop-app-managed sessions. So the first three can all pass in a session
 *    where the rewrite fails with an opaque TLS error. See
 *    {@link ../../proxy/loopback-reach.js decideReach} for the optimistic-once
 *    latch that closes that gap.
 *
 * Returns the endpoint state on success, else null (caller serves the floor).
 */
export async function greenServeState(
  projectDir: string,
  options: GreenServeOptions = {},
): Promise<LoopbackServeState | null> {
  const state = await readLoopbackServeState(projectDir);
  if (state === null) return null;

  const configured = process.env.NODE_EXTRA_CA_CERTS;
  if (configured === undefined || configured.length === 0) return null;
  const samePath = (a: string, b: string): boolean => {
    const [x, y] = [resolve(a), resolve(b)];
    return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
  };
  if (!samePath(configured, state.certPath)) return null;

  let certPem: string;
  try {
    certPem = await readFile(state.certPath, "utf8");
  } catch {
    return null;
  }
  if (!(await probeLoopbackServe(state, certPem))) return null;

  // R9.19 — the probe above proves the endpoint is reachable from HERE. Only a
  // recorded hit proves it is reachable from Claude Code.
  const [reach, hits] = await Promise.all([
    readLoopbackReach(projectDir),
    readLoopbackHits(projectDir),
  ]);
  const decision = decideReach(state.startedAt, reach, hits, options.nowMs ?? Date.now());
  if (decision.write !== null) await writeLoopbackReach(projectDir, decision.write);
  options.stderr?.write(`golem hook web-fetch-pre: green path — ${decision.reason}\n`);
  return decision.allowGreen ? state : null;
}

/** What a serve needs beyond the content: the original input, and the green verdict. */
export interface ServeContext {
  /** The original `tool_input`; `updatedInput` replaces it wholesale, so `prompt` must be carried. */
  readonly toolInput: unknown;
  /** Non-null → rewrite to the stub and render green; null → the deny floor. */
  readonly green: LoopbackServeState | null;
}

/**
 * Hand Claude a served page. Two shapes, one body:
 *
 * - **floor** (`green: null`): today's `deny` + content in `permissionDecisionReason`,
 *   byte-for-byte what R9.7 shipped. This is the known-good path, kept rather
 *   than reimplemented, so its framing survives every failure mode.
 * - **green**: `allow` + `updatedInput` pointing at the loopback stub + the same
 *   content in `additionalContext`, which §122 measured as reaching the model —
 *   and as still reaching it if the rewritten call fails.
 */
async function writeServed(
  io: HookIo,
  projectDir: string,
  url: string,
  content: string,
  head: string,
  ctx: ServeContext,
  source: ServeSource,
  age?: string,
): Promise<void> {
  let served: string;
  if (content.length > MAX_SERVED_CHARS) {
    const truncated = content.slice(0, MAX_SERVED_CHARS);
    // Stash the full page as a CCR ref so the whole thing is retrievable in one
    // `expand` call — not a vague "go search the KB" hint. Falls back to that
    // hint only when the CCR write fails (the content is still in the web cache
    // + vector KB regardless).
    const refId = await storeServedPageRef(projectDir, content);
    served =
      refId !== null
        ? `${truncated}\n\n[Golem: page truncated for inline display (${content.length} chars total); ` +
          `the full page is stored losslessly. Retrieve original: hash=${refId} — call the expand ` +
          `MCP tool with ref_id "${refId}" (or /golem/expand ${refId}).]`
        : `${truncated}\n\n[…truncated — full page is in the Golem KB; use search / fetch.]`;
  } else {
    served = content;
  }

  // Lazy-backfill pointer (T3): note an existing distill draft, if any.
  // Self-contained — a lookup failure here must never regress the serve.
  let draftNote = "";
  try {
    const draft = await findDraftByUrl(projectDir, url);
    if (draft !== null) {
      draftNote =
        `\n\n(A distilled source-note draft for this URL already exists at ${draft.path} — ` +
        "review it with `golem wiki distill --pending` rather than re-distilling.)";
    }
  } catch {
    // best-effort only
  }

  const body = `${served}${draftNote}`;

  if (ctx.green === null) {
    // The floor: byte-for-byte what R9.7 shipped.
    io.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `${NOT_AN_ERROR} ${head} ${RED_DOT_NOTE}\n\n${body}`,
        },
      })}\n`,
    );
    return;
  }

  // The green path. `updatedInput` replaces the ENTIRE input object (§115), so
  // `prompt` has to be carried across or the tool call is malformed.
  const input =
    typeof ctx.toolInput === "object" && ctx.toolInput !== null && !Array.isArray(ctx.toolInput)
      ? (ctx.toolInput as Record<string, unknown>)
      : {};
  io.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        // Shown to the user, not to Claude, on an `allow` — so it names the
        // mechanism rather than repeating the content.
        permissionDecisionReason: "Golem served this URL from its knowledge base (cached).",
        updatedInput: {
          url: loopbackServeUrl(ctx.green, url, source, age),
          prompt: typeof input.prompt === "string" ? input.prompt : "Summarize this page.",
        },
        additionalContext: `${head} ${GREEN_NOTE}\n\n${body}`,
      },
    })}\n`,
  );
}

/** Serve a fresh cache hit, skipping the fetch. */
export async function serveCached(
  io: HookIo,
  projectDir: string,
  url: string,
  entry: WebCacheEntry,
  nowMs: number,
  ctx: ServeContext,
): Promise<void> {
  await writeServed(
    io,
    projectDir,
    url,
    entry.content,
    `Golem served this URL from its knowledge base (fetched ${humanAge(entry.fetchedAt, nowMs)}), skipping the network fetch.`,
    ctx,
    "hit",
    humanAge(entry.fetchedAt, nowMs),
  );
}

/**
 * Serve a page Golem just fetched itself (Decision 42, Option A): the RAW page,
 * not WebFetch's prompt-specific summarizer output. Skips the WebFetch tool.
 */
export async function serveFetched(
  io: HookIo,
  projectDir: string,
  url: string,
  content: string,
  ctx: ServeContext,
): Promise<void> {
  await writeServed(
    io,
    projectDir,
    url,
    content,
    "Golem fetched this page directly and served its raw content (skipping WebFetch's summarizer, so the text is prompt-independent and now cached).",
    ctx,
    "miss",
  );
}
