/**
 * R2.2 (verification-notes §62) — `WebCache.list()` and `contentHashIndex()`,
 * the new surface proxy-side context substitution reads to recognize
 * already-cached page content by its sha256 hash.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentHashIndex, WebCache } from "../../../src/knowledge/web-cache.js";
import { rmTemp } from "../../helpers/tmp.js";

let dir: string;
let cache: WebCache;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "golem-webcache-"));
  cache = new WebCache(dir);
});

afterEach(async () => {
  await rm(dir, rmTemp);
});

describe("WebCache.list", () => {
  it("returns [] when the cache directory doesn't exist yet", async () => {
    expect(await cache.list()).toEqual([]);
  });

  it("returns every entry previously put", async () => {
    await cache.put("https://example.com/a", "content a", "2026-07-01T00:00:00.000Z");
    await cache.put("https://example.com/b", "content b", "2026-07-01T00:00:00.000Z");
    const entries = await cache.list();
    const urls = entries.map((e) => e.url).sort();
    expect(urls).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("skips corrupt/unparseable files rather than throwing", async () => {
    await cache.put("https://example.com/good", "good content", "2026-07-01T00:00:00.000Z");
    await writeFile(path.join(dir, "corrupt.json"), "not json{{{", "utf8");
    await writeFile(path.join(dir, "wrong-shape.json"), JSON.stringify({ foo: "bar" }), "utf8");
    const entries = await cache.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.url).toBe("https://example.com/good");
  });

  it("ignores non-.json files in the directory", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "README.md"), "not a cache entry", "utf8");
    expect(await cache.list()).toEqual([]);
  });
});

describe("WebCache revalidation metadata (R4 follow-up)", () => {
  const url = "https://example.com/doc";

  it("put stores optional etag/lastModified/expiresAt when given", async () => {
    await cache.put(url, "body", "2026-07-01T00:00:00.000Z", {
      etag: 'W/"v1"',
      lastModified: "Wed, 01 Jul 2026 00:00:00 GMT",
      expiresAt: "2026-07-02T00:00:00.000Z",
    });
    const entry = await cache.get(url);
    expect(entry?.etag).toBe('W/"v1"');
    expect(entry?.lastModified).toBe("Wed, 01 Jul 2026 00:00:00 GMT");
    expect(entry?.expiresAt).toBe("2026-07-02T00:00:00.000Z");
  });

  it("put drops stale validators when re-writing content without new meta", async () => {
    // New content invalidates old validators: put must NOT carry them over, or a
    // later 304 (matching the stale etag) would serve the wrong bytes as fresh.
    await cache.put(url, "old", "2026-07-01T00:00:00.000Z", { etag: 'W/"v1"' });
    await cache.put(url, "new content", "2026-07-02T00:00:00.000Z");
    const entry = await cache.get(url);
    expect(entry?.content).toBe("new content");
    expect(entry?.etag).toBeUndefined(); // stale validator dropped, not carried onto new content
  });

  it("updateMeta merges onto an existing entry, preserving fields not overridden", async () => {
    // updateMeta is the one place validators survive a write — safe because the
    // content is unchanged. Fields absent from the update keep their prior value.
    await cache.put(url, "body", "2026-07-01T00:00:00.000Z", {
      etag: 'W/"v1"',
      lastModified: "Wed, 01 Jul 2026 00:00:00 GMT",
    });
    await cache.updateMeta(url, { etag: 'W/"v2"', expiresAt: "2026-07-03T00:00:00.000Z" });
    const entry = await cache.get(url);
    expect(entry?.content).toBe("body");
    expect(entry?.fetchedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(entry?.etag).toBe('W/"v2"'); // overridden
    expect(entry?.lastModified).toBe("Wed, 01 Jul 2026 00:00:00 GMT"); // preserved
    expect(entry?.expiresAt).toBe("2026-07-03T00:00:00.000Z"); // added
  });

  it("updateMeta is a no-op when the URL isn't cached", async () => {
    await cache.updateMeta(url, { etag: 'W/"x"' });
    expect(await cache.get(url)).toBeNull();
  });

  it("delete removes an entry (and is a no-op when absent)", async () => {
    await cache.put(url, "body", "2026-07-01T00:00:00.000Z");
    await cache.delete(url);
    expect(await cache.get(url)).toBeNull();
    await cache.delete(url); // no throw on a missing entry
  });

  it("still parses legacy entries with no metadata fields", async () => {
    // Simulate a pre-revalidation cache file (only url/fetchedAt/content).
    await mkdir(dir, { recursive: true });
    const { webCacheKey } = await import("../../../src/knowledge/web-cache.js");
    await writeFile(
      path.join(dir, `${webCacheKey(url)}.json`),
      JSON.stringify({ url, fetchedAt: "2026-07-01T00:00:00.000Z", content: "legacy" }),
      "utf8",
    );
    const entry = await cache.get(url);
    expect(entry?.content).toBe("legacy");
    expect(entry?.etag).toBeUndefined();
  });
});

describe("contentHashIndex", () => {
  it("maps sha256(content) -> url for every cached entry", async () => {
    await cache.put("https://example.com/a", "hello world", "2026-07-01T00:00:00.000Z");
    const index = await contentHashIndex(cache);
    const hash = createHash("sha256").update("hello world", "utf8").digest("hex");
    expect(index.get(hash)).toBe("https://example.com/a");
    expect(index.size).toBe(1);
  });

  it("returns an empty map for an empty cache", async () => {
    const index = await contentHashIndex(cache);
    expect(index.size).toBe(0);
  });

  it("rebuilds fresh on every call — a later put() is reflected without re-instantiating", async () => {
    expect((await contentHashIndex(cache)).size).toBe(0);
    await cache.put("https://example.com/new", "new content", "2026-07-01T00:00:00.000Z");
    const index = await contentHashIndex(cache);
    const hash = createHash("sha256").update("new content", "utf8").digest("hex");
    expect(index.get(hash)).toBe("https://example.com/new");
  });
});
