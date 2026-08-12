/**
 * Conditional revalidation for the web cache (R4-followup).
 *
 * A cached-but-not-explicitly-fresh URL can be confirmed with a conditional GET
 * before it is served, so a page that changed is not served stale. The network
 * call itself is injectable ({@link RevalidateFn}) — tests never reach the
 * network, and the per-project gate lives in the CLI layer, not here.
 */

import type { WebCacheMeta } from "../../knowledge/index.js";

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
export function parseCacheControl(value: string | undefined): {
  noStore: boolean;
  maxAgeMs: number | undefined;
} {
  if (value === undefined) return { noStore: false, maxAgeMs: undefined };
  const lower = value.toLowerCase();
  const m = lower.match(/\bmax-age\s*=\s*(\d+)/);
  return { noStore: /\bno-store\b/.test(lower), maxAgeMs: m ? Number(m[1]) * 1000 : undefined };
}

/** Compute the cache-metadata to persist from a revalidation response. */
export function metaFrom(res: RevalidateResponse, nowMs: number): WebCacheMeta {
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
