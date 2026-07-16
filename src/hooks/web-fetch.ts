/**
 * WebFetch hooks (KB-backed web cache; verification-notes §44).
 *
 * - PreToolUse(WebFetch): if the exact URL is already in the project's web cache
 *   and still fresh, DENY the fetch and hand Claude the cached content via
 *   `permissionDecisionReason` (PreToolUse has no output-substitution field, but
 *   the deny reason is shown to Claude and the network fetch is skipped). Else
 *   allow the fetch (empty output).
 * - PostToolUse(WebFetch): capture the fetched content — redact, write it to the
 *   web cache, and ingest it into the vector KB (so `search` finds it and
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
  findDraftByUrl,
  type IncrementalIngest,
  isFresh,
  supportsIncremental,
  WebCache,
  type WebCacheEntry,
  type WebCacheMeta,
  webCacheDir,
} from "../knowledge/index.js";
import type { HookIo } from "./post-tool-use.js";
import { pipelineRedact, type RedactFn, stripKnownSecrets } from "./redact.js";

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

/** The status + validators/cache-directives from a conditional revalidation request. */
export interface RevalidateResponse {
  readonly status: number;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly cacheControl?: string;
  readonly expires?: string;
}

/** Conditional-GET a URL to check whether the cached copy is still current. */
export type RevalidateFn = (
  url: string,
  validators: {
    readonly etag?: string | undefined;
    readonly lastModified?: string | undefined;
    readonly fetchedAt: string;
  },
) => Promise<RevalidateResponse>;

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
  /**
   * Pipeline redaction stage; defaults to `pipelineRedact` (the full
   * REDACTION_RULES table + high-entropy sweep). The built-in secret strip
   * always runs on top, so injection can only strengthen redaction. Fetched
   * pages are stored in the web cache AND ingested into the vector KB, so they
   * must be redacted to the same standard as the CCR-swap path (T-C3).
   */
  readonly redact?: RedactFn;
  /**
   * R4-followup: conditional-revalidation fetcher (default {@link defaultRevalidate}
   * uses global `fetch`; tests inject a fake). When present AND
   * {@link revalidateEnabled} allows it, a cached-but-not-explicitly-fresh URL is
   * revalidated before serving. Absent → pure-TTL behavior (unchanged).
   */
  readonly revalidate?: RevalidateFn;
  /** Per-project gate for {@link revalidate}; CLI reads `knowledge.webcache_revalidate`. */
  readonly revalidateEnabled?: (projectDir: string) => Promise<boolean>;
}

/** Default {@link RevalidateFn}: a conditional GET that reads status + headers only (body cancelled). */
export const defaultRevalidate: RevalidateFn = async (url, v) => {
  const headers: Record<string, string> = {};
  if (v.etag !== undefined) headers["if-none-match"] = v.etag;
  headers["if-modified-since"] = v.lastModified ?? new Date(v.fetchedAt).toUTCString();
  const res = await fetch(url, { method: "GET", headers, redirect: "follow" });
  try {
    await res.body?.cancel(); // we only need status + headers, never the body
  } catch {
    // ignore
  }
  const etag = res.headers.get("etag") ?? undefined;
  const lastModified = res.headers.get("last-modified") ?? undefined;
  const cacheControl = res.headers.get("cache-control") ?? undefined;
  const expires = res.headers.get("expires") ?? undefined;
  return {
    status: res.status,
    ...(etag !== undefined ? { etag } : {}),
    ...(lastModified !== undefined ? { lastModified } : {}),
    ...(cacheControl !== undefined ? { cacheControl } : {}),
    ...(expires !== undefined ? { expires } : {}),
  };
};

/** Parse the relevant `Cache-Control` directives. */
function parseCacheControl(value: string | undefined): {
  noStore: boolean;
  maxAgeMs: number | undefined;
} {
  if (value === undefined) return { noStore: false, maxAgeMs: undefined };
  const lower = value.toLowerCase();
  const m = lower.match(/\bmax-age\s*=\s*(\d+)/);
  return { noStore: /\bno-store\b/.test(lower), maxAgeMs: m ? Number(m[1]) * 1000 : undefined };
}

/** Compute the cache-metadata to persist from a revalidation response. */
function metaFrom(res: RevalidateResponse, nowMs: number): WebCacheMeta {
  const cc = parseCacheControl(res.cacheControl);
  let expiresAt: string | undefined;
  if (cc.maxAgeMs !== undefined) {
    expiresAt = new Date(nowMs + cc.maxAgeMs).toISOString();
  } else if (res.expires !== undefined) {
    const exp = Date.parse(res.expires);
    if (Number.isFinite(exp)) expiresAt = new Date(exp).toISOString();
  }
  return {
    ...(res.etag !== undefined ? { etag: res.etag } : {}),
    ...(res.lastModified !== undefined ? { lastModified: res.lastModified } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

/** Write the deny-with-cached-content response for a cache hit. */
async function serveCached(
  io: HookIo,
  projectDir: string,
  url: string,
  entry: WebCacheEntry,
  nowMs: number,
): Promise<void> {
  const served =
    entry.content.length > MAX_SERVED_CHARS
      ? `${entry.content.slice(0, MAX_SERVED_CHARS)}\n\n[…truncated — full page is in the Golem KB; use search / fetch.]`
      : entry.content;

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

  const reason =
    `✓ Golem served this URL from the knowledge base (fetched ${humanAge(entry.fetchedAt, nowMs)}), ` +
    `skipping the web fetch. Content follows:\n\n${served}${draftNote}`;
  io.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
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
    if (!isFresh(entry, ttl, nowMs)) return 0; // past the hard TTL cap → re-fetch

    // Optional conditional revalidation (opt-in): confirm the cached copy is
    // still current before serving it, so a changed page isn't served stale.
    if (
      options.revalidate !== undefined &&
      (options.revalidateEnabled === undefined || (await options.revalidateEnabled(projectDir)))
    ) {
      // Honor an explicit freshness window (Cache-Control max-age / Expires) —
      // no network round-trip while the copy is provably fresh.
      const explicitlyFresh = entry.expiresAt !== undefined && Date.parse(entry.expiresAt) > nowMs;
      if (!explicitlyFresh) {
        let res: RevalidateResponse | null = null;
        try {
          res = await options.revalidate(url, {
            etag: entry.etag,
            lastModified: entry.lastModified,
            fetchedAt: entry.fetchedAt,
          });
        } catch {
          res = null; // offline / failure → fall through and serve the cache (still within TTL)
        }
        if (res !== null) {
          if (parseCacheControl(res.cacheControl).noStore) {
            await cache.delete(url);
            return 0; // uncacheable now → re-fetch
          }
          if (res.status === 200) {
            // Changed: drop the stale entry outright, then let the fetch proceed
            // (re-cache + re-ingest via the post hook). We deliberately do NOT
            // stash the new validators onto the old content — if the re-fetch is
            // cancelled/declined, a bare miss just re-fetches later, whereas old
            // content wearing new validators would be served as fresh by a future
            // 304. Fresh validators repopulate on the next revalidation.
            await cache.delete(url);
            return 0;
          }
          if (res.status === 304) {
            await cache.updateMeta(url, metaFrom(res, nowMs)); // unchanged → refresh validators/expiry
          }
          // 304 and any other status fall through to serving the cached copy.
        }
      }
    }

    await serveCached(io, projectDir, url, entry, nowMs);
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
    // Redact BEFORE storing/ingesting (hard rule): pipeline stage first
    // (defaults to pipelineRedact), built-in secret strip always on top.
    const content = stripKnownSecrets((options.redact ?? pipelineRedact)(text));

    await (options.cache ?? new WebCache(webCacheDir(projectDir))).put(url, content, nowIso);

    // Also ingest into the vector KB for semantic search (same embedder as
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
