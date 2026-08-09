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
 * R9.7: a served page therefore renders as a FAILED (red) tool call in Claude
 * Code — it is a `deny`. This is accepted deliberately, not unfixed: the only
 * green alternative is `updatedInput` + `allow` pointing at a loopback endpoint,
 * and WebFetch forces http→https and validates the certificate, so that endpoint
 * needs a cert Claude Code trusts, and it re-adds an uncached summarizer call per
 * fetch. Measured and declined in verification-notes §120; the serve text says so
 * out loud instead. §121 corrects the cert half — a `CA:FALSE` leaf in
 * NODE_EXTRA_CA_CERTS suffices (no CA, no signing power) — so the standing reasons
 * are the per-fetch summarizer cost, the fidelity loss, and that the wiring is
 * silently inert in cloud/Desktop-managed sessions. Opt-in candidate: R9.12.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { CcrStore, estimateTokens, LocalDirBlobStore } from "../compression/index.js";
import type { KnowledgeBase } from "../interfaces/knowledge.js";
import {
  fetchRawPage,
  findDraftByUrl,
  type IncrementalIngest,
  isFresh,
  type RawPage,
  supportsIncremental,
  WebCache,
  type WebCacheEntry,
  type WebCacheMeta,
  webCacheDir,
} from "../knowledge/index.js";
import type { HookIo } from "./post-tool-use.js";
import { pipelineRedact, type RedactFn, stripKnownSecrets } from "./redact.js";

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

/** Write a `deny` PreToolUse decision that hands Claude `content` as the reason. */
async function writeServedDeny(
  io: HookIo,
  projectDir: string,
  url: string,
  content: string,
  intro: string,
): Promise<void> {
  let served: string;
  if (content.length > MAX_SERVED_CHARS) {
    const head = content.slice(0, MAX_SERVED_CHARS);
    // Stash the full page as a CCR ref so the whole thing is retrievable in one
    // `expand` call — not a vague "go search the KB" hint. Falls back to that
    // hint only when the CCR write fails (the content is still in the web cache
    // + vector KB regardless).
    const refId = await storeServedPageRef(projectDir, content);
    served =
      refId !== null
        ? `${head}\n\n[Golem: page truncated for inline display (${content.length} chars total); ` +
          `the full page is stored losslessly. Retrieve original: hash=${refId} — call the expand ` +
          `MCP tool with ref_id "${refId}" (or /golem/expand ${refId}).]`
        : `${head}\n\n[…truncated — full page is in the Golem KB; use search / fetch.]`;
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

  io.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `${intro}\n\n${served}${draftNote}`,
      },
    })}\n`,
  );
}

/** Serve a fresh cache hit (deny + cached content), skipping the fetch. */
async function serveCached(
  io: HookIo,
  projectDir: string,
  url: string,
  entry: WebCacheEntry,
  nowMs: number,
): Promise<void> {
  await writeServedDeny(
    io,
    projectDir,
    url,
    entry.content,
    `${NOT_AN_ERROR} Golem served this URL from its knowledge base (fetched ${humanAge(entry.fetchedAt, nowMs)}), skipping the network fetch. ${RED_DOT_NOTE}`,
  );
}

/**
 * Serve a page Golem just fetched itself (Decision 42, Option A): the RAW page,
 * not WebFetch's prompt-specific summarizer output. Skips the WebFetch tool.
 */
async function serveFetched(
  io: HookIo,
  projectDir: string,
  url: string,
  content: string,
): Promise<void> {
  await writeServedDeny(
    io,
    projectDir,
    url,
    content,
    `${NOT_AN_ERROR} Golem fetched this page directly and served its raw content (skipping WebFetch's summarizer, so the text is prompt-independent and now cached). ${RED_DOT_NOTE}`,
  );
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

  await serveFetched(io, projectDir, url, content);
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

    // "Should we self-fetch and serve the raw page for this miss?" In raw mode we
    // do; otherwise we fall open and let the post hook capture WebFetch's answer.
    const serveMiss = (): Promise<boolean> =>
      rawMode
        ? fetchCacheAndServe(io, projectDir, cache, url, options, nowMs, nowIso)
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

    await serveCached(io, projectDir, url, entry, nowMs);
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
