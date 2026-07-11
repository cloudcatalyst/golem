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

let dir: string;
let cache: WebCache;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "golem-webcache-"));
  cache = new WebCache(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
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
