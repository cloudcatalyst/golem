/**
 * WebFetch hooks: PostToolUse captures a fetched page into the web cache + KB;
 * PreToolUse serves a fresh cached URL (deny + content) and lets uncached/stale
 * URLs through. Uses the real WebCache + hashing KB (no network, no Ollama).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CcrStore, LocalDirBlobStore } from "../../../src/compression/index.js";
import { type HookIo, runWebFetchPost, runWebFetchPre } from "../../../src/hooks/index.js";
import { MAX_SERVED_CHARS } from "../../../src/hooks/web-fetch.js";
import {
  openKnowledgeBase,
  WebCache,
  webCacheDir,
  webCacheKey,
  writeDraftFile,
} from "../../../src/knowledge/index.js";

let projectDir: string;
beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-webfetch-"));
});
afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

function fakeIo(input: string): HookIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdin: (async function* () {
      yield input;
    })(),
    stdout: { write: (t: string) => out.push(t) },
    stderr: { write: (t: string) => err.push(t) },
    out,
    err,
  };
}

const preInput = (url: string) =>
  JSON.stringify({ cwd: projectDir, tool_name: "WebFetch", tool_input: { url, prompt: "?" } });
const postInput = (url: string, response: unknown) =>
  JSON.stringify({
    cwd: projectDir,
    tool_name: "WebFetch",
    tool_input: { url },
    tool_response: response,
  });

const buildKnowledge = async (dir: string) => openKnowledgeBase({ projectDir: dir });

describe("WebFetch capture (PostToolUse)", () => {
  it("writes the fetched page to the web cache and the vector KB", async () => {
    const url = "https://example.com/guide";
    const io = fakeIo(postInput(url, "# Guide\n\nHow to configure the widget factory.\n"));
    const code = await runWebFetchPost(io, {
      projectDir,
      nowIso: "2026-07-05T00:00:00Z",
      buildKnowledge,
    });
    expect(code).toBe(0);
    expect(io.out).toStrictEqual([]); // store-only, no stdout

    // Web cache has it...
    const entry = await new WebCache(webCacheDir(projectDir)).get(url);
    expect(entry?.content).toContain("widget factory");

    // ...and search finds it.
    const kb = openKnowledgeBase({ projectDir });
    const hits = await kb.search("configure widget factory", projectDir, 3);
    expect(hits[0]?.chunk.sourcePath).toBe(`web:${url}`);
  });

  it("redacts secrets (full pipeline, not just the floor) before caching + ingesting", async () => {
    // A canonical AWS docs example access-key ID, assembled from fragments so
    // the contiguous AKIA-pattern never appears as a literal in this source
    // file (this repo's own Golem proxy would otherwise redact it in tooling
    // views). It is matched by the pipeline's `aws-key` rule but NOT by the
    // built-in floor (PEM / sk-ant only) — so it proves the capture path runs
    // the full pipeline, not identityRedact; otherwise the key would land
    // verbatim in the web cache and the vector KB.
    const url = "https://example.com/leak";
    const awsKey = `AKIA${"IOSFODNN7EXAMPLE"}`; // 20 chars: AKIA + 16
    await runWebFetchPost(fakeIo(postInput(url, `deploy notes\naws_key ${awsKey}\nfin.`)), {
      projectDir,
      nowIso: "2026-07-05T00:00:00Z",
      buildKnowledge,
    });

    const cached = (await new WebCache(webCacheDir(projectDir)).get(url))?.content ?? "";
    expect(cached).not.toContain(awsKey); // the raw key must not be stored
    expect(cached).toContain("[REDACTED:aws-key:"); // replaced by the pipeline placeholder
    expect(cached).toContain("deploy notes"); // surrounding content preserved
  });

  it("extracts content from a {output} response shape too", async () => {
    const url = "https://example.com/x";
    await runWebFetchPost(fakeIo(postInput(url, { output: "Alpha beta gamma delta." })), {
      projectDir,
      nowIso: "2026-07-05T00:00:00Z",
      buildKnowledge,
    });
    expect((await new WebCache(webCacheDir(projectDir)).get(url))?.content).toContain("gamma");
  });
});

describe("WebFetch raw-page engine — Option A (Decision 42)", () => {
  const url = "https://example.com/api";
  // A raw fetcher standing in for fetchRawPage: returns the page, not the answer.
  const rawFetcher = async (u: string) => ({
    content: `RAW PAGE for ${u} — the full documentation text.`,
    headers: { etag: 'W/"v1"', cacheControl: "max-age=3600" } as const,
  });
  const cache = () => new WebCache(webCacheDir(projectDir));
  const preOpts = (over: Record<string, unknown> = {}) => ({
    projectDir,
    nowIso: "2026-07-23T00:00:00Z",
    nowMs: Date.parse("2026-07-23T00:00:00Z"),
    ttlHours: 168,
    buildKnowledge,
    fetchRaw: rawFetcher,
    fetchRawEnabled: async () => true,
    ...over,
  });

  it("on a MISS: fetches the raw page, caches it (raw:true + validators), and serves it", async () => {
    const io = fakeIo(preInput(url));
    const code = await runWebFetchPre(io, preOpts());
    expect(code).toBe(0);

    // Served to Claude via a deny, and it's the raw page.
    const decision = JSON.parse(io.out[0] ?? "{}");
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("RAW PAGE");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("fetched this page");

    // Cached as raw, with validators seeded from the real fetch.
    const entry = await cache().get(url);
    expect(entry?.content).toContain("RAW PAGE");
    expect(entry?.raw).toBe(true);
    expect(entry?.etag).toBe('W/"v1"');
    expect(entry?.expiresAt).toBeDefined(); // from max-age=3600

    // ...and ingested so search finds it.
    const hits = await openKnowledgeBase({ projectDir }).search(
      "full documentation text",
      projectDir,
      3,
    );
    expect(hits[0]?.chunk.sourcePath).toBe(`web:${url}`);
  });

  it("falls OPEN (lets WebFetch run) and caches nothing when the raw fetch fails", async () => {
    const io = fakeIo(preInput(url));
    await runWebFetchPre(
      io,
      preOpts({
        fetchRaw: async () => {
          throw new Error("403 Forbidden");
        },
      }),
    );
    expect(io.out).toStrictEqual([]); // no deny → WebFetch proceeds
    expect(await cache().get(url)).toBeNull(); // nothing cached
  });

  it("treats a legacy answer-entry (no raw marker) as a miss → re-fetches the raw page", async () => {
    await cache().put(url, "STALE ANSWER", "2026-07-23T00:00:00Z"); // legacy, no raw flag
    const io = fakeIo(preInput(url));
    await runWebFetchPre(io, preOpts({ nowMs: Date.parse("2026-07-23T00:30:00Z") }));
    // Served the freshly-fetched raw page, and the cache is now a raw entry.
    expect(io.out[0]).toContain("RAW PAGE");
    const entry = await cache().get(url);
    expect(entry?.raw).toBe(true);
    expect(entry?.content).not.toContain("STALE ANSWER");
  });

  it("serves a fresh raw entry from cache without re-fetching", async () => {
    await cache().put(url, "CACHED RAW BODY", "2026-07-23T00:00:00Z", { raw: true });
    let fetched = false;
    const io = fakeIo(preInput(url));
    await runWebFetchPre(
      io,
      preOpts({
        nowMs: Date.parse("2026-07-23T00:30:00Z"),
        fetchRaw: async () => {
          fetched = true;
          return { content: "SHOULD NOT FETCH", headers: {} };
        },
      }),
    );
    expect(fetched).toBe(false); // fresh hit → no self-fetch
    expect(io.out[0]).toContain("CACHED RAW BODY");
  });

  it("re-fetches the raw page when revalidation reports the entry changed (200)", async () => {
    await cache().put(url, "OLD RAW", "2026-07-22T00:00:00Z", { raw: true, etag: 'W/"old"' });
    const io = fakeIo(preInput(url));
    await runWebFetchPre(
      io,
      preOpts({
        nowMs: Date.parse("2026-07-23T00:30:00Z"),
        revalidate: async () => ({ status: 200, etag: 'W/"new"' }),
        revalidateEnabled: async () => true,
      }),
    );
    expect(io.out[0]).toContain("RAW PAGE"); // served the freshly re-fetched page
    const entry = await cache().get(url);
    expect(entry?.content).toContain("RAW PAGE");
    expect(entry?.etag).toBe('W/"v1"'); // validators from the re-fetch, not the stale 'old'
  });

  it("PostToolUse is a no-op in raw mode (never caches WebFetch's answer)", async () => {
    const io = fakeIo(postInput(url, "Answer: the auth param is X."));
    await runWebFetchPost(io, {
      projectDir,
      nowIso: "2026-07-23T00:00:00Z",
      buildKnowledge,
      fetchRaw: rawFetcher,
      fetchRawEnabled: async () => true,
    });
    expect(await cache().get(url)).toBeNull(); // answer NOT cached
  });

  it("with raw mode OFF: PreToolUse falls open on a miss and PostToolUse caches the answer", async () => {
    const preIo = fakeIo(preInput(url));
    await runWebFetchPre(preIo, preOpts({ fetchRawEnabled: async () => false }));
    expect(preIo.out).toStrictEqual([]); // legacy: miss → allow the fetch

    const postIo = fakeIo(postInput(url, "Legacy answer body."));
    await runWebFetchPost(postIo, {
      projectDir,
      nowIso: "2026-07-23T00:00:00Z",
      fetchRaw: rawFetcher,
      fetchRawEnabled: async () => false,
    });
    const entry = await cache().get(url);
    expect(entry?.content).toContain("Legacy answer body.");
    expect(entry?.raw).toBeUndefined();
  });
});

describe("WebFetch gate (PreToolUse)", () => {
  it("serves a fresh cached URL (deny + content), skipping the fetch", async () => {
    const url = "https://example.com/cached";
    await new WebCache(webCacheDir(projectDir)).put(
      url,
      "CACHED BODY TEXT",
      "2026-07-05T00:00:00Z",
    );

    const io = fakeIo(preInput(url));
    await runWebFetchPre(io, {
      projectDir,
      nowMs: Date.parse("2026-07-05T01:00:00Z"),
      ttlHours: 168,
    });
    expect(io.out).toHaveLength(1);
    const decision = JSON.parse(io.out[0] ?? "{}");
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("CACHED BODY TEXT");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("knowledge base");
  });

  it("stores an oversized served page as a CCR ref and emits an expand handle", async () => {
    const url = "https://example.com/huge";
    // A page well over the inline cap: only a head excerpt should be served
    // inline, with a precise `expand` handle for the full text.
    const big = "X".repeat(MAX_SERVED_CHARS + 5_000);
    await new WebCache(webCacheDir(projectDir)).put(url, big, "2026-07-05T00:00:00Z");

    const io = fakeIo(preInput(url));
    await runWebFetchPre(io, {
      projectDir,
      nowMs: Date.parse("2026-07-05T01:00:00Z"),
      ttlHours: 168,
    });

    const reason = JSON.parse(io.out[0] ?? "{}").hookSpecificOutput
      .permissionDecisionReason as string;
    // A precise `hash=<sha256>` expand handle, not the vague KB-search hint.
    const match = reason.match(/hash=([0-9a-f]{64})/);
    expect(match).not.toBeNull();
    expect(reason).toContain("expand MCP tool");
    expect(reason).not.toContain("use search / fetch");
    // Only a head excerpt is served inline (well under the full page).
    expect(reason.length).toBeLessThan(big.length);

    // ...and the full page round-trips losslessly from the CCR store.
    const refId = match?.[1] ?? "";
    const ccr = new CcrStore(new LocalDirBlobStore(path.join(projectDir, ".golem", "ccr")));
    const envelope = await ccr.getEnvelope(refId);
    expect(envelope.content).toBe(big);
  });

  it("lets an UNCACHED url through (no output = allow)", async () => {
    const io = fakeIo(preInput("https://example.com/never-seen"));
    await runWebFetchPre(io, { projectDir, nowMs: Date.now() });
    expect(io.out).toStrictEqual([]);
  });

  it("lets a STALE cached url through (past TTL)", async () => {
    const url = "https://example.com/old";
    await new WebCache(webCacheDir(projectDir)).put(url, "OLD", "2026-07-01T00:00:00Z");
    const io = fakeIo(preInput(url));
    // 5 days later, ttl 24h → stale.
    await runWebFetchPre(io, {
      projectDir,
      nowMs: Date.parse("2026-07-06T00:00:00Z"),
      ttlHours: 24,
    });
    expect(io.out).toStrictEqual([]);
  });

  it("notes an existing distill draft in the served reason (T3 lazy backfill)", async () => {
    const url = "https://example.com/cached";
    await new WebCache(webCacheDir(projectDir)).put(
      url,
      "CACHED BODY TEXT",
      "2026-07-05T00:00:00Z",
    );
    await writeDraftFile(
      projectDir,
      url,
      {
        title: "Cached Page Basics",
        slug: "cached-page-basics",
        tags: ["misc"],
        summary: "summary",
        wikilinks: [],
      },
      "2026-07-05T00:00:00Z",
    );

    const io = fakeIo(preInput(url));
    await runWebFetchPre(io, {
      projectDir,
      nowMs: Date.parse("2026-07-05T01:00:00Z"),
      ttlHours: 168,
    });
    const decision = JSON.parse(io.out[0] ?? "{}");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain(
      "distilled source-note draft for this URL already exists",
    );
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("cached-page-basics.md");
  });

  it("round-trips: capture then the very next fetch is served from cache", async () => {
    const url = "https://example.com/rt";
    await runWebFetchPost(fakeIo(postInput(url, "Roundtrip content here.")), {
      projectDir,
      nowIso: "2026-07-05T00:00:00Z",
      buildKnowledge,
    });
    const io = fakeIo(preInput(url));
    await runWebFetchPre(io, { projectDir, nowMs: Date.parse("2026-07-05T00:05:00Z") });
    expect(io.out[0]).toContain("Roundtrip content here.");
  });
});

describe("WebFetch pre-hook conditional revalidation (opt-in)", () => {
  const url = "https://example.com/doc";
  const nowMs = Date.parse("2026-07-06T00:00:00Z");
  const seed = () =>
    new WebCache(webCacheDir(projectDir)).put(url, "CACHED DOC BODY", "2026-07-01T00:00:00Z");

  it("serves the cache on 304 and refreshes validators", async () => {
    await seed();
    const calls: string[] = [];
    const io = fakeIo(preInput(url));
    await runWebFetchPre(io, {
      projectDir,
      nowMs,
      ttlHours: 168,
      revalidate: async (u) => {
        calls.push(u);
        return { status: 304, etag: 'W/"v2"', cacheControl: "max-age=3600" };
      },
    });
    expect(calls).toStrictEqual([url]);
    expect(io.out[0]).toContain("CACHED DOC BODY"); // 304 → served from cache
    // Validators were refreshed for next time.
    const entry = await new WebCache(webCacheDir(projectDir)).get(url);
    expect(entry?.etag).toBe('W/"v2"');
    expect(entry?.expiresAt).toBeDefined();
  });

  it("drops the stale entry and lets the fetch re-run on 200 (changed)", async () => {
    await seed();
    const io = fakeIo(preInput(url));
    await runWebFetchPre(io, {
      projectDir,
      nowMs,
      ttlHours: 168,
      revalidate: async () => ({
        status: 200,
        etag: 'W/"v3"',
        lastModified: "Wed, 01 Jul 2026 00:00:00 GMT",
      }),
    });
    expect(io.out).toStrictEqual([]); // allow the fetch (changed)
    // The stale entry is dropped, not left wearing the new validators — a
    // cancelled re-fetch must never leave old content that a future 304 serves
    // as fresh. The post hook re-caches fresh content when the fetch completes.
    expect(await new WebCache(webCacheDir(projectDir)).get(url)).toBeNull();
  });

  it("sends conditional headers from the stored validators", async () => {
    await new WebCache(webCacheDir(projectDir)).put(url, "BODY", "2026-07-01T00:00:00Z", {
      etag: 'W/"v1"',
    });
    let seen:
      | { etag?: string | undefined; lastModified?: string | undefined; fetchedAt: string }
      | undefined;
    await runWebFetchPre(fakeIo(preInput(url)), {
      projectDir,
      nowMs,
      ttlHours: 168,
      revalidate: async (_u, v) => {
        seen = v;
        return { status: 304 };
      },
    });
    expect(seen?.etag).toBe('W/"v1"');
    expect(seen?.fetchedAt).toBe("2026-07-01T00:00:00Z");
  });

  it("skips the network call while an explicit freshness window (expiresAt) holds", async () => {
    await new WebCache(webCacheDir(projectDir)).put(url, "FRESH BODY", "2026-07-05T23:00:00Z", {
      expiresAt: "2026-07-06T06:00:00Z", // still fresh at nowMs
    });
    let called = false;
    const io = fakeIo(preInput(url));
    await runWebFetchPre(io, {
      projectDir,
      nowMs,
      ttlHours: 168,
      revalidate: async () => {
        called = true;
        return { status: 200 };
      },
    });
    expect(called).toBe(false); // provably fresh → no revalidation
    expect(io.out[0]).toContain("FRESH BODY");
  });

  it("drops the entry and re-fetches when revalidation returns no-store", async () => {
    await seed();
    const io = fakeIo(preInput(url));
    await runWebFetchPre(io, {
      projectDir,
      nowMs,
      ttlHours: 168,
      revalidate: async () => ({ status: 200, cacheControl: "no-store" }),
    });
    expect(io.out).toStrictEqual([]); // allow
    expect(await new WebCache(webCacheDir(projectDir)).get(url)).toBeNull(); // dropped
  });

  it("serves the cache when revalidation fails (offline-friendly)", async () => {
    await seed();
    const io = fakeIo(preInput(url));
    await runWebFetchPre(io, {
      projectDir,
      nowMs,
      ttlHours: 168,
      revalidate: async () => {
        throw new Error("network down");
      },
    });
    expect(io.out[0]).toContain("CACHED DOC BODY"); // fell back to cache
  });

  it("does not revalidate when the enable predicate is false (pure-TTL)", async () => {
    await seed();
    let called = false;
    const io = fakeIo(preInput(url));
    await runWebFetchPre(io, {
      projectDir,
      nowMs,
      ttlHours: 168,
      revalidate: async () => {
        called = true;
        return { status: 200 };
      },
      revalidateEnabled: async () => false,
    });
    expect(called).toBe(false);
    expect(io.out[0]).toContain("CACHED DOC BODY"); // served without revalidation
  });
});

describe("WebCache.get corrupt entries", () => {
  it("resolves null (not a rejection) for a syntactically-invalid JSON cache file", async () => {
    const url = "https://example.com/corrupt";
    const dir = webCacheDir(projectDir);
    await mkdir(dir, { recursive: true });
    // Simulate a crash mid-write (put() is a plain non-atomic writeFile): the
    // file exists and is readable but is not valid JSON.
    await writeFile(path.join(dir, `${webCacheKey(url)}.json`), '{"url": "trunc', "utf8");

    await expect(new WebCache(dir).get(url)).resolves.toBeNull();
  });
});
