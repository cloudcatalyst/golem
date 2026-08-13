/**
 * Raw-page fetch for the WebFetch cache (spec Decision 42).
 *
 * Claude Code's WebFetch returns a *prompt-processed answer*, not the page —
 * so caching its `tool_response` keyed by URL serves the wrong answer to a
 * later fetch with a different prompt, and makes a poor KB citation source.
 * To cache the raw page, Golem must fetch it itself; this module is that
 * fetch: `fetch()` → dispatch on content-type → HTML/PDF text extraction.
 *
 * The returned {@link RawPageHeaders} carry the HTTP validators so the caller
 * can seed the web cache's revalidation metadata from a real fetch (today they
 * only populate after a separate conditional GET).
 *
 * Dependency-free besides the shared extractors. Never called on the
 * latency-sensitive proxy path — only from the store-only PostToolUse hook.
 */

import { extractHtmlText, extractPdfText } from "./extractors.js";

/** HTTP validators / cache directives captured from the raw fetch (all optional). */
export interface RawPageHeaders {
  readonly etag?: string;
  readonly lastModified?: string;
  readonly cacheControl?: string;
  readonly expires?: string;
}

/** A fetched raw page: extracted text plus the response's cache headers. */
export interface RawPage {
  readonly content: string;
  readonly headers: RawPageHeaders;
}

/**
 * Default request timeout — this fetch blocks the WebFetch tool (Decision 42,
 * Option A).
 *
 * R9.21: this was **15_000, exactly equal to the PreToolUse hook's
 * `timeoutSeconds: 15`**, so the fetch was entitled to the hook's whole budget and
 * anything that had to happen afterwards — extraction, redaction, the cache write,
 * the serve — ran past the platform's kill deadline. The hook then died with the
 * page downloaded and cached but never served, and WebFetch fetched it again.
 *
 * Two guards now. The PreToolUse hook passes an explicit remaining-budget
 * argument, so it no longer relies on this default at all; and this default is
 * lower than any hook timeout, so a caller that forgets to pass one still leaves
 * room to use what it fetched. Do not raise it to match a hook timeout again —
 * that equality was the bug.
 */
export const DEFAULT_RAW_FETCH_TIMEOUT_MS = 11_000;

/** Does the URL's path (ignoring query/hash) end in `.pdf`? */
function isPdfPath(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return url.toLowerCase().endsWith(".pdf");
  }
}

/**
 * Fetch `url` and return its raw text (HTML stripped to visible text, PDFs
 * extracted, anything else verbatim) plus the response's cache headers.
 * Throws on a network failure, a timeout, or a non-2xx status — the caller
 * treats a throw as "don't cache / fall open" rather than poisoning the cache.
 * `timeoutMs` bounds the request because this fetch runs on the WebFetch
 * tool's critical path (Decision 42, Option A) — a hang would stall the tool.
 */
export async function fetchRawPage(
  url: string,
  timeoutMs: number = DEFAULT_RAW_FETCH_TIMEOUT_MS,
): Promise<RawPage> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`fetchRawPage: ${url} returned ${res.status} ${res.statusText}`);
  }

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  let content: string;
  if (contentType.includes("application/pdf") || isPdfPath(url)) {
    content = await extractPdfText(new Uint8Array(await res.arrayBuffer()));
  } else if (contentType.includes("html")) {
    content = extractHtmlText(await res.text());
  } else {
    content = await res.text();
  }

  const etag = res.headers.get("etag") ?? undefined;
  const lastModified = res.headers.get("last-modified") ?? undefined;
  const cacheControl = res.headers.get("cache-control") ?? undefined;
  const expires = res.headers.get("expires") ?? undefined;
  const headers: RawPageHeaders = {
    ...(etag !== undefined ? { etag } : {}),
    ...(lastModified !== undefined ? { lastModified } : {}),
    ...(cacheControl !== undefined ? { cacheControl } : {}),
    ...(expires !== undefined ? { expires } : {}),
  };

  return { content, headers };
}
