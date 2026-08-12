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
 *
 * ## Layout
 * This module is the decision engine — freshness, revalidation, raw-fetch mode,
 * and the fail-open policy. The two halves it drives live beside it and are
 * re-exported here so every existing importer is unaffected:
 *   - `./web-fetch/serve.js` — how a page is handed back (green `allow` vs the
 *     red `deny` floor, R9.12) and the CCR ref for an oversized page
 *   - `./web-fetch/revalidate.js` — the conditional-GET stage and its cache-meta
 */

import { z } from "zod";
import type { KnowledgeBase } from "../interfaces/knowledge.js";
import {
  fetchRawPage,
  type IncrementalIngest,
  isFresh,
  type RawPage,
  supportsIncremental,
  WebCache,
  type WebCacheMeta,
  webCacheDir,
} from "../knowledge/index.js";
import { isLoopbackStubUrl } from "../proxy/loopback-serve.js";
import { type HookIo, readAll } from "./hook-io.js";
import { pipelineRedact, type RedactFn, stripKnownSecrets } from "./redact.js";
import {
  metaFrom,
  parseCacheControl,
  type RevalidateFn,
  type RevalidateResponse,
} from "./web-fetch/revalidate.js";
import {
  greenServeState,
  type ServeContext,
  serveCached,
  serveFetched,
} from "./web-fetch/serve.js";

export {
  defaultRevalidate,
  type RevalidateFn,
  type RevalidateResponse,
} from "./web-fetch/revalidate.js";
export { MAX_SERVED_CHARS } from "./web-fetch/serve.js";

/** Default freshness window for a cached URL. */
export const DEFAULT_WEB_CACHE_TTL_HOURS = 168; // 7 days

const payloadSchema = z
  .object({
    cwd: z.string().optional(),
    tool_input: z.unknown().optional(),
    tool_response: z.unknown().optional(),
  })
  .passthrough();

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
   * R4-followup: conditional-revalidation fetcher (default `defaultRevalidate`
   * uses global `fetch`; tests inject a fake). When present AND
   * {@link revalidateEnabled} allows it, a cached-but-not-explicitly-fresh URL is
   * revalidated before serving. Absent → pure-TTL behavior (unchanged).
   */
  readonly revalidate?: RevalidateFn;
  /** Per-project gate for {@link revalidate}; CLI reads `knowledge.webcache_revalidate`. */
  readonly revalidateEnabled?: (projectDir: string) => Promise<boolean>;
  /**
   * Decision 42: fetch the RAW page ourselves (default {@link fetchRawPage} via
   * the CLI wiring; tests inject a fake). When present AND {@link fetchRawEnabled}
   * allows it, the PostToolUse hook caches/ingests the raw page instead of Claude
   * Code's prompt-specific WebFetch answer. A raw fetch that throws caches
   * nothing (an honest miss) — the answer is never stored. Absent → legacy
   * answer-capture behavior.
   */
  readonly fetchRaw?: (url: string) => Promise<RawPage>;
  /** Per-project gate for {@link fetchRaw}; CLI reads `knowledge.webcache_fetch_raw`. */
  readonly fetchRawEnabled?: (projectDir: string) => Promise<boolean>;
}

/** Best-effort ingest of a fetched page into the vector KB (same embedder as auto-index). */
async function ingestWebPage(
  options: WebFetchHookOptions,
  projectDir: string,
  url: string,
  content: string,
  fetchedAt: string,
): Promise<void> {
  if (options.buildKnowledge === undefined) return;
  const kb = await options.buildKnowledge(projectDir);
  if (kb !== null && supportsIncremental(kb)) {
    await (kb as KnowledgeBase & IncrementalIngest).ingestText(projectDir, `web:${url}`, content, {
      url,
      fetchedAt,
      kind: "web",
    });
  }
}

/**
 * Decision 42 (Option A): on a cache miss, fetch the RAW page ourselves, cache +
 * ingest it, and serve it back via a `deny` — so Claude Code's WebFetch never
 * runs. Returns true when served; false when the caller should fail open and let
 * WebFetch run (fetch failed, or the extracted page was empty). Only the network
 * fetch is treated as fail-open; a cache/serve error propagates to the caller's
 * outer fail-safe.
 */
async function fetchCacheAndServe(
  io: HookIo,
  projectDir: string,
  cache: WebCache,
  url: string,
  options: WebFetchHookOptions,
  nowMs: number,
  nowIso: string,
  ctx: ServeContext,
): Promise<boolean> {
  const fetchRaw = options.fetchRaw;
  if (fetchRaw === undefined) return false; // caller guarantees this; narrows the type

  let raw: RawPage;
  try {
    raw = await fetchRaw(url);
  } catch (err) {
    io.stderr.write(
      `golem hook web-fetch-pre: raw fetch of ${url} failed (${
        err instanceof Error ? err.message : String(err)
      }); allowing WebFetch\n`,
    );
    return false; // fail-open: let Claude Code's WebFetch handle it
  }

  // Redact BEFORE storing/serving (hard rule): pipeline stage first, built-in strip on top.
  const content = stripKnownSecrets((options.redact ?? pipelineRedact)(raw.content));
  if (content.length === 0) return false; // empty extraction → let WebFetch try

  const meta: WebCacheMeta = { ...metaFrom({ status: 200, ...raw.headers }, nowMs), raw: true };
  await cache.put(url, content, nowIso, meta);

  // Ingest is best-effort — a KB failure must never block serving the page.
  try {
    await ingestWebPage(options, projectDir, url, content, nowIso);
  } catch {
    // best-effort only
  }

  await serveFetched(io, projectDir, url, content, ctx);
  return true;
}

/**
 * PreToolUse(WebFetch). Decision 42, Option A: raw mode makes this the canonical
 * fetch-cache-serve engine — on a cache miss (or a stale/changed/legacy entry) it
 * fetches the RAW page itself, caches + ingests it, and serves it via `deny`, so
 * Claude Code's WebFetch never runs. A failed self-fetch falls open (WebFetch
 * runs). With raw mode off it degrades to the legacy behavior: serve a fresh
 * cached entry, else allow the fetch (the post hook captures the answer).
 */
export async function runWebFetchPre(
  io: HookIo,
  options: WebFetchHookOptions = {},
): Promise<number> {
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(await readAll(io.stdin)));
    if (!parsed.success) return 0;
    const url = urlOf(parsed.data.tool_input);
    if (url === null) return 0;
    // Our own rewrite (R9.12) — let it through untouched, never re-serve it.
    if (isLoopbackStubUrl(url)) return 0;

    const projectDir = options.projectDir ?? parsed.data.cwd ?? process.cwd();
    const cache = options.cache ?? new WebCache(webCacheDir(projectDir));
    const ttl = options.ttlHours ?? DEFAULT_WEB_CACHE_TTL_HOURS;
    const nowMs = options.nowMs ?? Date.now();
    const nowIso = options.nowIso ?? new Date().toISOString();

    // Raw mode: a fetcher is wired (CLI injects fetchRawPage) AND the per-project
    // gate allows it. When on, this hook owns caching and serves the raw page.
    const rawMode =
      options.fetchRaw !== undefined &&
      (options.fetchRawEnabled === undefined || (await options.fetchRawEnabled(projectDir)));

    // R9.12: decide ONCE per call whether this session can render green. Failing
    // closed here is what keeps a cert-less session byte-identical to R9.7.
    const ctx: ServeContext = {
      toolInput: parsed.data.tool_input,
      green: await greenServeState(projectDir),
    };

    // "Should we self-fetch and serve the raw page for this miss?" In raw mode we
    // do; otherwise we fall open and let the post hook capture WebFetch's answer.
    const serveMiss = (): Promise<boolean> =>
      rawMode
        ? fetchCacheAndServe(io, projectDir, cache, url, options, nowMs, nowIso, ctx)
        : Promise.resolve(false);

    const entry = await cache.get(url);

    // Miss, past-TTL, or (in raw mode) a legacy answer-entry with no `raw` marker →
    // treat as a miss so we never keep serving a stale prompt-specific answer.
    const usableHit =
      entry !== null && isFresh(entry, ttl, nowMs) && (!rawMode || entry.raw === true);
    if (!usableHit) {
      await serveMiss(); // served the raw page (raw mode) or fell open — either way exit 0
      return 0;
    }

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
            await serveMiss(); // uncacheable now → re-fetch ourselves (raw mode) or fall open
            return 0;
          }
          if (res.status === 200) {
            // Changed: drop the stale entry, then re-fetch. We deliberately do NOT
            // stash the new validators onto the old content — a cancelled re-fetch
            // must never leave old content that a future 304 serves as fresh.
            await cache.delete(url);
            await serveMiss();
            return 0;
          }
          if (res.status === 304) {
            await cache.updateMeta(url, metaFrom(res, nowMs)); // unchanged → refresh validators/expiry
          }
          // 304 and any other status fall through to serving the cached copy.
        }
      }
    }

    await serveCached(io, projectDir, url, entry, nowMs, ctx);
    return 0;
  } catch (err) {
    io.stderr.write(
      `golem hook web-fetch-pre: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 0; // fail-open: allow the fetch
  }
}

/**
 * PostToolUse(WebFetch): store-only capture of WebFetch's answer. Store-only.
 *
 * Decision 42, Option A: in raw mode the PRE hook is the canonical cache writer
 * (it fetches + serves the raw page, so the tool usually never runs). This hook
 * therefore fires only when the pre hook fell open — a failed self-fetch — and in
 * that case it deliberately caches NOTHING: storing WebFetch's prompt-specific
 * answer is exactly the bug Decision 42 fixes. It caches the answer only when raw
 * mode is OFF (the legacy behavior).
 */
export async function runWebFetchPost(
  io: HookIo,
  options: WebFetchHookOptions = {},
): Promise<number> {
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(await readAll(io.stdin)));
    if (!parsed.success) return 0;
    const url = urlOf(parsed.data.tool_input);
    if (url === null) return 0;

    const projectDir = options.projectDir ?? parsed.data.cwd ?? process.cwd();

    // Never cache Golem's own placeholder as if it were the page (R9.12). The
    // human-facing label for a served fetch is emitted by the CCR post hook, not
    // here: this one is registered `async`, so its stdout is discarded.
    if (isLoopbackStubUrl(url)) return 0;

    // Raw mode → the pre hook owns caching; never cache WebFetch's answer here.
    const rawMode =
      options.fetchRaw !== undefined &&
      (options.fetchRawEnabled === undefined || (await options.fetchRawEnabled(projectDir)));
    if (rawMode) return 0;

    // Legacy path (raw mode off): cache + ingest WebFetch's answer, redacted.
    const text = textOf(parsed.data.tool_response);
    if (text === null || text.length === 0) return 0;
    const nowIso = options.nowIso ?? new Date().toISOString();
    // Redact BEFORE storing/ingesting (hard rule): pipeline stage first
    // (defaults to pipelineRedact), built-in secret strip always on top.
    const content = stripKnownSecrets((options.redact ?? pipelineRedact)(text));
    if (content.length === 0) return 0;

    await (options.cache ?? new WebCache(webCacheDir(projectDir))).put(url, content, nowIso);
    await ingestWebPage(options, projectDir, url, content, nowIso);
    return 0; // store-only: never write stdout
  } catch (err) {
    io.stderr.write(
      `golem hook web-fetch-post: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 0;
  }
}
