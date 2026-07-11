/**
 * R1.1 — GolemProxy's onResponseUsage callback must fire with correctly
 * extracted usage for both non-streaming and SSE responses, WITHOUT altering
 * byte-for-byte fidelity to the client (verification-notes §30-37).
 */

import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { ProxyRequest, ResponseUsage } from "../../src/proxy/index.js";
import {
  chunkify,
  NON_STREAMING_TOOL_USE_RESPONSE,
  SSE_STREAM_FIXTURE,
} from "./helpers/anthropic-fixtures.js";
import {
  type FakeUpstream,
  type RunningProxy,
  rawRequest,
  startProxy,
  startUpstream,
  writeChunked,
} from "./helpers/test-servers.js";

const HOSTILE_CHUNK_SIZES = [7, 1, 3, 2, 11, 5, 64, 1, 129] as const;

describe("GolemProxy onResponseUsage wiring", () => {
  let upstream: FakeUpstream;

  it("fires with the extracted usage block for a non-streaming JSON response, body untouched", async () => {
    upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(NON_STREAMING_TOOL_USE_RESPONSE);
    });
    const seen: Array<ResponseUsage | null> = [];
    let proxy: RunningProxy | undefined;
    try {
      proxy = await startProxy({
        upstreamBaseUrl: upstream.origin,
        onResponseUsage: (usage) => seen.push(usage),
      });
      const response = await rawRequest(proxy.origin, "/v1/messages", { method: "POST" });
      expect(response.body.toString("utf8")).toBe(NON_STREAMING_TOOL_USE_RESPONSE);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toStrictEqual({
        inputTokens: 2095,
        cacheCreationInputTokens: 1024,
        cacheReadInputTokens: 1024,
        outputTokens: 89,
      });
    } finally {
      await proxy?.close();
      await upstream.close();
    }
  });

  it("fires with the extracted usage block for a hostile-chunked SSE stream, body byte-identical", async () => {
    upstream = await startUpstream(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      await writeChunked(res, chunkify(Buffer.from(SSE_STREAM_FIXTURE), HOSTILE_CHUNK_SIZES));
    });
    const seen: Array<ResponseUsage | null> = [];
    let proxy: RunningProxy | undefined;
    try {
      proxy = await startProxy({
        upstreamBaseUrl: upstream.origin,
        onResponseUsage: (usage) => seen.push(usage),
      });
      const response = await rawRequest(proxy.origin, "/v1/messages", { method: "POST" });
      expect(response.body.equals(Buffer.from(SSE_STREAM_FIXTURE))).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toStrictEqual({
        inputTokens: 472,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 448,
        outputTokens: 189,
      });
    } finally {
      await proxy?.close();
      await upstream.close();
    }
  });

  it("does not construct a sniffer or alter behavior when onResponseUsage is absent", async () => {
    upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(NON_STREAMING_TOOL_USE_RESPONSE);
    });
    let proxy: RunningProxy | undefined;
    try {
      proxy = await startProxy({ upstreamBaseUrl: upstream.origin });
      const response = await rawRequest(proxy.origin, "/v1/messages", { method: "POST" });
      expect(response.body.toString("utf8")).toBe(NON_STREAMING_TOOL_USE_RESPONSE);
    } finally {
      await proxy?.close();
      await upstream.close();
    }
  });

  it("fires with the extracted usage block for a gzip-encoded response (real upstream shape), body untouched", async () => {
    const gzipped = gzipSync(Buffer.from(NON_STREAMING_TOOL_USE_RESPONSE, "utf8"));
    upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(gzipped);
    });
    const seen: Array<ResponseUsage | null> = [];
    let proxy: RunningProxy | undefined;
    try {
      proxy = await startProxy({
        upstreamBaseUrl: upstream.origin,
        onResponseUsage: (usage) => seen.push(usage),
      });
      const response = await rawRequest(proxy.origin, "/v1/messages", { method: "POST" });
      // The client receives the exact gzip bytes — decoding happens client-side.
      expect(response.body.equals(gzipped)).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toStrictEqual({
        inputTokens: 2095,
        cacheCreationInputTokens: 1024,
        cacheReadInputTokens: 1024,
        outputTokens: 89,
      });
    } finally {
      await proxy?.close();
      await upstream.close();
    }
  });

  it("passes the forwarded ProxyRequest alongside the usage block", async () => {
    upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(NON_STREAMING_TOOL_USE_RESPONSE);
    });
    const seenRequests: ProxyRequest[] = [];
    let proxy: RunningProxy | undefined;
    try {
      proxy = await startProxy({
        upstreamBaseUrl: upstream.origin,
        onResponseUsage: (_usage, request) => seenRequests.push(request),
      });
      await rawRequest(proxy.origin, "/v1/messages", { method: "POST" });
      expect(seenRequests).toHaveLength(1);
      expect(seenRequests[0]?.url).toBe("/v1/messages");
      expect(seenRequests[0]?.method).toBe("POST");
    } finally {
      await proxy?.close();
      await upstream.close();
    }
  });
});
