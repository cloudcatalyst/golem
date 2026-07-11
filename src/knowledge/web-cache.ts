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
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const entrySchema = z.object({
  url: z.string(),
  fetchedAt: z.string(),
  content: z.string(),
});

export type WebCacheEntry = z.infer<typeof entrySchema>;

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

  /** Store (or refresh) the content for `url`. */
  async put(url: string, content: string, fetchedAt: string): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const entry: WebCacheEntry = { url, fetchedAt, content };
    await writeFile(this.#fileFor(url), `${JSON.stringify(entry)}\n`, "utf8");
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
