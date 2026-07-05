/**
 * WebFetch hooks (KB-backed web cache; verification-notes §44).
 *
 * - PreToolUse(WebFetch): if the exact URL is already in the project's web cache
 *   and still fresh, DENY the fetch and hand Claude the cached content via
 *   `permissionDecisionReason` (PreToolUse has no output-substitution field, but
 *   the deny reason is shown to Claude and the network fetch is skipped). Else
 *   allow the fetch (empty output).
 * - PostToolUse(WebFetch): capture the fetched content — redact, write it to the
 *   web cache, and ingest it into the vector KB (so `golem_search` finds it and
 *   re-fetches stay in sync). Store-only: writes NO stdout, so it never conflicts
 *   with the CCR-swap PostToolUse hook that shares the WebFetch matcher.
 *
 * Fail-safe: any error → exit 0 with no stdout (the fetch proceeds / the capture
 * is skipped) so a hook can never break a session. Redaction runs BEFORE storage
 * (hard rule).
 */

import { z } from "zod";
import type { KnowledgeBase } from "../interfaces/knowledge.js";
import {
  type IncrementalIngest,
  isFresh,
  supportsIncremental,
  WebCache,
  webCacheDir,
} from "../knowledge/index.js";
import type { HookIo } from "./post-tool-use.js";
import { identityRedact, type RedactFn, stripKnownSecrets } from "./redact.js";

/** Cap on cached content echoed in a deny reason (Claude Code flags hook output >10k chars). */
export const MAX_SERVED_CHARS = 8_000;
/** Default freshness window for a cached URL. */
export const DEFAULT_WEB_CACHE_TTL_HOURS = 168; // 7 days

const payloadSchema = z
  .object({
    cwd: z.string().optional(),
    tool_input: z.unknown().optional(),
    tool_response: z.unknown().optional(),
  })
  .passthrough();

async function readAll(stream: AsyncIterable<string | Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of stream) {
    out += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  }
  return out + decoder.decode();
}

/** Pull the URL out of a WebFetch `tool_input` (`{url, prompt}`). */
function urlOf(toolInput: unknown): string | null {
  if (typeof toolInput === "object" && toolInput !== null && !Array.isArray(toolInput)) {
    const u = (toolInput as Record<string, unknown>).url;
    if (typeof u === "string" && u.length > 0) return u;
  }
  return null;
}

/** Extract the dominant text from a `tool_response` (string, or {output|content|text|...}). */
function textOf(response: unknown): string | null {
  if (typeof response === "string") return response;
  if (typeof response === "object" && response !== null && !Array.isArray(response)) {
    const r = response as Record<string, unknown>;
    for (const key of ["output", "content", "text", "result", "markdown"] as const) {
      if (typeof r[key] === "string") return r[key] as string;
    }
  }
  return null;
}

function humanAge(fetchedAt: string, nowMs: number): string {
  const ms = nowMs - Date.parse(fetchedAt);
  if (!Number.isFinite(ms) || ms < 0) return "recently";
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return "under an hour ago";
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export interface WebFetchHookOptions {
  readonly projectDir?: string;
  readonly ttlHours?: number;
  /** Current time (epoch ms + ISO); injected so tests control the clock. */
  readonly nowMs?: number;
  readonly nowIso?: string;
  /** Inject a WebCache (tests); default: `<projectDir>/.golem/webcache`. */
  readonly cache?: WebCache;
  /** Build a KB for the project (cli injects buildKnowledgeStack). Post hook only. */
  readonly buildKnowledge?: (projectDir: string) => Promise<KnowledgeBase | null>;
  /** Pipeline redaction stage; the built-in secret strip always runs on top. */
  readonly redact?: RedactFn;
}

/** PreToolUse(WebFetch): serve a fresh cached URL and skip the fetch, else allow. */
export async function runWebFetchPre(
  io: HookIo,
  options: WebFetchHookOptions = {},
): Promise<number> {
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(await readAll(io.stdin)));
    if (!parsed.success) return 0;
    const url = urlOf(parsed.data.tool_input);
    if (url === null) return 0;

    const projectDir = options.projectDir ?? parsed.data.cwd ?? process.cwd();
    const cache = options.cache ?? new WebCache(webCacheDir(projectDir));
    const entry = await cache.get(url);
    if (entry === null) return 0; // not cached → let the fetch proceed

    const ttl = options.ttlHours ?? DEFAULT_WEB_CACHE_TTL_HOURS;
    const nowMs = options.nowMs ?? Date.now();
    if (!isFresh(entry, ttl, nowMs)) return 0; // stale → re-fetch

    const served =
      entry.content.length > MAX_SERVED_CHARS
        ? `${entry.content.slice(0, MAX_SERVED_CHARS)}\n\n[…truncated — full page is in the Golem KB; use golem_search / golem_get_chunk.]`
        : entry.content;
    const reason =
      `✓ Golem served this URL from the knowledge base (fetched ${humanAge(entry.fetchedAt, nowMs)}), ` +
      `skipping the web fetch. Content follows:\n\n${served}`;
    io.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      })}\n`,
    );
    return 0;
  } catch (err) {
    io.stderr.write(
      `golem hook web-fetch-pre: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 0; // fail-open: allow the fetch
  }
}

/** PostToolUse(WebFetch): redact + cache + ingest the fetched content. Store-only. */
export async function runWebFetchPost(
  io: HookIo,
  options: WebFetchHookOptions = {},
): Promise<number> {
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(await readAll(io.stdin)));
    if (!parsed.success) return 0;
    const url = urlOf(parsed.data.tool_input);
    const text = textOf(parsed.data.tool_response);
    if (url === null || text === null || text.length === 0) return 0;

    const projectDir = options.projectDir ?? parsed.data.cwd ?? process.cwd();
    const nowIso = options.nowIso ?? new Date().toISOString();
    // Redact BEFORE storing (hard rule): injected stage first, built-in strip on top.
    const content = stripKnownSecrets((options.redact ?? identityRedact)(text));

    await (options.cache ?? new WebCache(webCacheDir(projectDir))).put(url, content, nowIso);

    // Also ingest into the vector KB for semantic golem_search (same embedder as
    // auto-index, so the collection isn't corrupted by mixed dimensions).
    if (options.buildKnowledge !== undefined) {
      const kb = await options.buildKnowledge(projectDir);
      if (kb !== null && supportsIncremental(kb)) {
        await (kb as KnowledgeBase & IncrementalIngest).ingestText(
          projectDir,
          `web:${url}`,
          content,
          {
            url,
            fetchedAt: nowIso,
            kind: "web",
          },
        );
      }
    }
    return 0; // store-only: never write stdout
  } catch (err) {
    io.stderr.write(
      `golem hook web-fetch-post: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 0;
  }
}
