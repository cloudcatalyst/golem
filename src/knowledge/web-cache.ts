/**
 * WS-C — web-fetch cache. A tiny content-addressed store keyed by URL under
 * `<project>/.golem/webcache`, so the PreToolUse(WebFetch) gate can answer
 * "have we already fetched this URL (recently)?" with a single file read — no
 * vector search on the latency-sensitive pre-tool path. The same content is ALSO
 * ingested into the vector KB (for semantic `golem_search`); this store is the
 * exact-URL index + freshness clock on top of it.
 *
 * Pure/dependency-free (node:fs/crypto). Entries are validated on read (external
 * surface); a corrupt/missing entry is simply a miss.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
}
