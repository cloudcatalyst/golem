/**
 * WS-C — web-fetch cache. A tiny content-addressed store keyed by URL under
 * `<project>/.golem/webcache`, so the PreToolUse(WebFetch) gate can answer
 * "have we already fetched this URL (recently)?" with a single file read — no
 * vector search on the latency-sensitive pre-tool path. The same content is ALSO
 * ingested into the vector KB (for semantic `search`); this store is the
 * exact-URL index + freshness clock on top of it.
 *
 * Pure/dependency-free (node:fs/crypto). Entries are validated on read (external
 * surface); a corrupt/missing entry is simply a miss.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const entrySchema = z.object({
  url: z.string(),
  fetchedAt: z.string(),
  content: z.string(),
  // R4-followup: HTTP revalidation metadata, captured by the pre-hook's
  // conditional request (optional — absent on entries written before this /
  // without revalidation enabled, so old caches still parse).
  etag: z.string().optional(),
  lastModified: z.string().optional(),
  /** Absolute ISO time before which the entry is fresh (from Cache-Control max-age / Expires). */
  expiresAt: z.string().optional(),
});

export type WebCacheEntry = z.infer<typeof entrySchema>;

/** Revalidation metadata mergeable onto an entry (all optional). */
export type WebCacheMeta = Partial<Pick<WebCacheEntry, "etag" | "lastModified" | "expiresAt">>;

/** Where a project's web-fetch cache lives. */
export function webCacheDir(projectDir: string): string {
  return path.join(projectDir, ".golem", "webcache");
}

/** Stable per-URL cache filename (sha256 of the URL). */
export function webCacheKey(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("hex").slice(0, 32);
}

/** Is a cache entry still within `ttlHours` of `nowMs`? A future/invalid ts counts as stale. */
export function isFresh(entry: WebCacheEntry, ttlHours: number, nowMs: number): boolean {
  const fetched = Date.parse(entry.fetchedAt);
  if (!Number.isFinite(fetched)) return false;
  const ageMs = nowMs - fetched;
  return ageMs >= 0 && ageMs < ttlHours * 3_600_000;
}

export class WebCache {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  #fileFor(url: string): string {
    return path.join(this.#dir, `${webCacheKey(url)}.json`);
  }

  /** Read the entry for `url`, or null on miss/corrupt. */
  async get(url: string): Promise<WebCacheEntry | null> {
    let raw: string;
    try {
      raw = await readFile(this.#fileFor(url), "utf8");
    } catch {
      return null;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return null;
    }
    const parsed = entrySchema.safeParse(parsedJson);
    // URL collision guard: the stored url must match (sha prefix is not unique-proof).
    return parsed.success && parsed.data.url === url ? parsed.data : null;
  }

  /**
   * Store (or refresh) the content for `url`, overwriting any prior entry.
   * Validators in `meta` describe THIS `content` and are stored alongside it;
   * validators NOT passed are dropped, never carried over from a prior entry —
   * new content invalidates old validators (an entry's validators must always
   * describe its own content, or a later `304` would serve stale bytes as
   * fresh). Metadata-only refreshes, where the content is unchanged, go through
   * {@link updateMeta}, which merges.
   */
  async put(url: string, content: string, fetchedAt: string, meta?: WebCacheMeta): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const entry: WebCacheEntry = {
      url,
      fetchedAt,
      content,
      ...(meta?.etag !== undefined ? { etag: meta.etag } : {}),
      ...(meta?.lastModified !== undefined ? { lastModified: meta.lastModified } : {}),
      ...(meta?.expiresAt !== undefined ? { expiresAt: meta.expiresAt } : {}),
    };
    await writeFile(this.#fileFor(url), `${JSON.stringify(entry)}\n`, "utf8");
  }

  /**
   * Merge revalidation metadata onto an existing entry without touching its
   * content or `fetchedAt`. Fields absent from `meta` keep their prior value;
   * this is the ONLY place validators are preserved across a write, and it is
   * safe because the content does not change. No-op if the URL isn't cached.
   * Used by the pre-hook on a `304` (unchanged) to refresh validators/expiry.
   */
  async updateMeta(url: string, meta: WebCacheMeta): Promise<void> {
    const entry = await this.get(url);
    if (entry === null) return;
    const etag = meta.etag ?? entry.etag;
    const lastModified = meta.lastModified ?? entry.lastModified;
    const expiresAt = meta.expiresAt ?? entry.expiresAt;
    await this.put(url, entry.content, entry.fetchedAt, {
      ...(etag !== undefined ? { etag } : {}),
      ...(lastModified !== undefined ? { lastModified } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    });
  }

  /** Remove the entry for `url` (e.g. a revalidation returned `Cache-Control: no-store`). */
  async delete(url: string): Promise<void> {
    await rm(this.#fileFor(url), { force: true });
  }

  /**
   * All entries currently in the cache (R2.2, verification-notes §62) — used
   * to build a content-hash index for proxy-side context substitution.
   * Best-effort: an unreadable directory yields `[]`; a corrupt/unparseable
   * file is skipped rather than throwing (same tolerance as {@link get}).
   */
  async list(): Promise<WebCacheEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch {
      return [];
    }
    const entries: WebCacheEntry[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = await readFile(path.join(this.#dir, name), "utf8");
        const parsed = entrySchema.safeParse(JSON.parse(raw));
        if (parsed.success) entries.push(parsed.data);
      } catch {
        // Corrupt/unreadable — skip, best effort.
      }
    }
    return entries;
  }
}

/**
 * sha256(content) -> url, across every entry currently in the cache. Rebuilt
 * from scratch on every call (no incremental index) — deliberately, since the
 * cache grows across requests and the caller (context-substitution.ts) needs
 * a fresh view every time to stay correct; see its module doc for why that
 * caller only ever consults this on non-caching upstreams.
 */
export async function contentHashIndex(cache: WebCache): Promise<Map<string, string>> {
  const entries = await cache.list();
  const index = new Map<string, string>();
  for (const entry of entries) {
    index.set(createHash("sha256").update(entry.content, "utf8").digest("hex"), entry.url);
  }
  return index;
}
