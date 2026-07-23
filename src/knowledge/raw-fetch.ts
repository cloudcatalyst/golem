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
 * Throws on a network failure or a non-2xx status — the caller treats a throw
 * as "cache nothing" rather than poisoning the cache.
 */
export async function fetchRawPage(url: string): Promise<RawPage> {
  const res = await fetch(url, { redirect: "follow" });
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
