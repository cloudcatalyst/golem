/**
 * Workstream B (Decision 52 follow-up) — Anthropic **tool search** fidelity
 * through the proxy.
 *
 * Why this file exists. `golem init` writes `ENABLE_TOOL_SEARCH=true` into
 * `.claude/settings.json` (`src/cli/init.ts`), because Claude Code disables tool
 * search by default behind a non-first-party `ANTHROPIC_BASE_URL` and only
 * honours it if the proxy relays `tool_reference` blocks correctly
 * (verification-notes §12). So real sessions send tool-search-shaped request
 * bodies through Golem *today*, and until this file existed nothing asserted
 * they survived the pipeline.
 *
 * What the live docs say the request looks like (verified 2026-07-30,
 * notes §89 — https://docs.claude.com/en/docs/agents-and-tools/tool-use/tool-search-tool):
 *
 *  - a `tool_search_tool_regex_20251119` / `tool_search_tool_bm25_20251119`
 *    entry sits in `tools` and is NEVER deferred;
 *  - every other definition is still sent **in full** on every request, marked
 *    `defer_loading: true` — the flag controls what enters the model's context
 *    server-side, not what the client transmits;
 *  - a deferred tool may not carry `cache_control` (the API 400s), so the cache
 *    breakpoint rides on a non-deferred tool.
 *
 * All three are load-bearing for a proxy: dropping `defer_loading`, reordering
 * `tools`, or moving a `cache_control` breakpoint would each turn a working
 * 85%-saving setup into a silently degraded or 400-ing one.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { NativeLosslessCompression } from "../../src/compression/index.js";
import { type CompressionLevel, policyFor } from "../../src/interfaces/policy.js";
import { createGolemPipeline } from "../../src/pipeline/index.js";
import { useTempDirs } from "../helpers/tmp.js";
import { rawRequest, startProxy, startUpstream } from "./helpers/test-servers.js";

let projectDir: string;

const newTempDir = useTempDirs("golem-toolsearch-");

beforeEach(async () => {
  projectDir = await newTempDir();
});

function recordingUpstream() {
  const received: { body: string } = { body: "" };
  return {
    received,
    handler: (_req: unknown, res: import("node:http").ServerResponse, body: Buffer): void => {
      received.body = body.toString("utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  };
}

function pipelineFor(level: CompressionLevel) {
  return createGolemPipeline({
    compression: NativeLosslessCompression.forProjectDir(projectDir),
    policy: () => policyFor(level),
    projectId: projectDir,
  });
}

/**
 * A request body in the exact shape the docs specify: one non-deferred search
 * tool carrying the cache breakpoint, plus deferred full definitions.
 */
function toolSearchBody(): string {
  return JSON.stringify({
    model: "claude-opus-5",
    max_tokens: 2048,
    messages: [{ role: "user", content: "What is the weather in San Francisco?" }],
    tools: [
      {
        type: "tool_search_tool_regex_20251119",
        name: "tool_search_tool_regex",
        cache_control: { type: "ephemeral" },
      },
      {
        name: "get_weather",
        description: "Get the weather at a specific location",
        input_schema: {
          type: "object",
          properties: {
            location: { type: "string" },
            unit: { type: "string", enum: ["celsius", "fahrenheit"] },
          },
          required: ["location"],
        },
        defer_loading: true,
      },
      {
        name: "search_files",
        description: "Search through files in the workspace",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        defer_loading: true,
      },
    ],
  });
}

describe("tool search request fidelity through the proxy", () => {
  for (const level of ["off", 1] as const) {
    it(`level ${level}: forwards a tool-search request body byte-for-byte`, async () => {
      const up = recordingUpstream();
      const upstream = await startUpstream(up.handler);
      const proxy = await startProxy({
        upstreamBaseUrl: upstream.origin,
        pipeline: pipelineFor(level),
      });
      try {
        const body = toolSearchBody();
        await rawRequest(proxy.origin, "/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        // Byte-faithful is the hard rule at level <= 1 (CLAUDE.md). The tools
        // block renders FIRST in the cached prefix, so a single reordered or
        // re-serialized key here invalidates the whole prefix (notes §88).
        expect(up.received.body).toBe(body);
      } finally {
        await proxy.close();
        await upstream.close();
      }
    });
  }

  it("preserves defer_loading, the search-tool type, and tools order at every level", async () => {
    // Levels 2/3 may legitimately transform *message* content; the tools block
    // is not theirs to touch, and the three flags below are the ones whose loss
    // is silent rather than loud.
    for (const level of ["off", 1, 2, 3] as const) {
      const up = recordingUpstream();
      const upstream = await startUpstream(up.handler);
      const proxy = await startProxy({
        upstreamBaseUrl: upstream.origin,
        pipeline: pipelineFor(level),
      });
      try {
        await rawRequest(proxy.origin, "/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: toolSearchBody(),
        });
        const forwarded = JSON.parse(up.received.body) as {
          tools: {
            name: string;
            type?: string;
            defer_loading?: boolean;
            cache_control?: unknown;
          }[];
        };
        expect(forwarded.tools.map((t) => t.name)).toStrictEqual([
          "tool_search_tool_regex",
          "get_weather",
          "search_files",
        ]);
        expect(forwarded.tools[0]?.type).toBe("tool_search_tool_regex_20251119");
        // The search tool must stay non-deferred (all-deferred is a 400) and
        // keep the breakpoint a deferred tool is not allowed to carry.
        expect(forwarded.tools[0]?.defer_loading).toBeUndefined();
        expect(forwarded.tools[0]?.cache_control).toStrictEqual({ type: "ephemeral" });
        expect(forwarded.tools[1]?.defer_loading).toBe(true);
        expect(forwarded.tools[2]?.defer_loading).toBe(true);
      } finally {
        await proxy.close();
        await upstream.close();
      }
    }
  });

  it("relays a tool_search_tool_result / tool_reference response unchanged", async () => {
    // The response side is what `ENABLE_TOOL_SEARCH=true` actually depends on:
    // Claude Code re-enables tool search behind a gateway only if these blocks
    // come back intact (notes §12). The streaming form is covered by
    // SSE_STREAM_FIXTURE in proxy-streaming.test.ts; this is the JSON form.
    const responseBody = JSON.stringify({
      id: "msg_01",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [
        {
          type: "server_tool_use",
          id: "srvtoolu_01ABC123",
          name: "tool_search_tool_regex",
          input: { pattern: "weather" },
        },
        {
          type: "tool_search_tool_result",
          tool_use_id: "srvtoolu_01ABC123",
          content: {
            type: "tool_search_tool_search_result",
            tool_references: [{ type: "tool_reference", tool_name: "get_weather" }],
          },
        },
        {
          type: "tool_use",
          id: "toolu_01XYZ789",
          name: "get_weather",
          input: { location: "San Francisco", unit: "fahrenheit" },
        },
      ],
      stop_reason: "tool_use",
    });
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(responseBody);
    });
    const proxy = await startProxy({
      upstreamBaseUrl: upstream.origin,
      pipeline: pipelineFor(1),
    });
    try {
      const res = await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: toolSearchBody(),
      });
      expect(res.status).toBe(200);
      expect(res.body.toString("utf8")).toBe(responseBody);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});
