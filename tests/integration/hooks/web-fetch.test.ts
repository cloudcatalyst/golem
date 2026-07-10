/**
 * WebFetch hooks: PostToolUse captures a fetched page into the web cache + KB;
 * PreToolUse serves a fresh cached URL (deny + content) and lets uncached/stale
 * URLs through. Uses the real WebCache + hashing KB (no network, no Ollama).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HookIo, runWebFetchPost, runWebFetchPre } from "../../../src/hooks/index.js";
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
