/**
 * R6.1 case (b) slice b4-gemini — the proxy's translating seam driving a Gemini
 * upstream: proves the per-request PATH OVERRIDE (model + method + alt=sse +
 * ?key=) and Gemini↔Anthropic body translation, non-streaming and streaming.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  anthropicToGemini,
  createGeminiToAnthropicSSE,
  geminiPath,
  geminiToAnthropic,
} from "../../src/providers/index.js";
import type { UpstreamTranslator } from "../../src/proxy/index.js";
import {
  type FakeUpstream,
  type RunningProxy,
  rawRequest,
  startProxy,
  startUpstream,
} from "./helpers/test-servers.js";

function geminiTranslator(base: string, model: string, key: string): UpstreamTranslator {
  const fallback = { id: "msg_g", model };
  return {
    path: geminiPath(base, model, false, key),
    translateRequest: (b) => {
      const { body, stream, model: m } = anthropicToGemini(b, { model });
      return {
        body: Buffer.from(JSON.stringify(body)),
        stream,
        path: geminiPath(base, m, stream, key),
      };
    },
    translateResponse: (b) => Buffer.from(JSON.stringify(geminiToAnthropic(b, fallback))),
    createStreamTranslator: () => createGeminiToAnthropicSSE(fallback),
  };
}

describe("proxy Gemini translation seam (R6.1 b4-gemini)", () => {
  let upstream: FakeUpstream;
  let proxy: RunningProxy;
  let lastRequest: { path: string; body: unknown } | null = null;
  let base = "";

  beforeEach(async () => {
    lastRequest = null;
    upstream = await startUpstream((req, res, body) => {
      lastRequest = { path: req.url ?? "", body: JSON.parse(body.toString("utf8") || "{}") };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          responseId: "r1",
          modelVersion: "gemini-2.0-flash",
          candidates: [{ content: { parts: [{ text: "42" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 1 },
        }),
      );
    });
    base = `${upstream.origin}/v1beta`;
    proxy = await startProxy({
      upstreamBaseUrl: base,
      translateUpstream: geminiTranslator(base, "gemini-2.0-flash", "KEY"),
    });
  });

  afterEach(async () => {
    await proxy.close();
    await upstream.close();
  });

  it("routes to the Gemini model path with ?key= and translates the response", async () => {
    const response = await rawRequest(proxy.origin, "/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "6*7?" }],
      }),
    });

    // The per-request path override reached the upstream (model + method + key).
    expect(lastRequest?.path).toBe("/v1beta/models/gemini-2.0-flash:generateContent?key=KEY");
    // Body was translated to the Gemini shape.
    const sent = lastRequest?.body as { contents: Array<{ role: string; parts: unknown[] }> };
    expect(sent.contents).toEqual([{ role: "user", parts: [{ text: "6*7?" }] }]);

    // Client got an Anthropic Messages response.
    expect(response.status).toBe(200);
    const b = JSON.parse(response.body.toString("utf8"));
    expect(b.type).toBe("message");
    expect(b.model).toBe("gemini-2.0-flash");
    expect(b.content).toEqual([{ type: "text", text: "42" }]);
    expect(b.usage).toEqual({ input_tokens: 7, output_tokens: 1 });
  });

  it("streams: uses streamGenerateContent?alt=sse and yields an Anthropic SSE stream", async () => {
    await upstream.close();
    upstream = await startUpstream((req, res, body) => {
      lastRequest = { path: req.url ?? "", body: JSON.parse(body.toString("utf8") || "{}") };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        'data: {"responseId":"r1","modelVersion":"gemini-2.0-flash","candidates":[{"content":{"parts":[{"text":"4"}]}}]}\n\n',
      );
      res.write(
        'data: {"candidates":[{"content":{"parts":[{"text":"2"}]},"finishReason":"STOP"}]}\n\n',
      );
      res.end();
    });
    base = `${upstream.origin}/v1beta`;
    await proxy.close();
    proxy = await startProxy({
      upstreamBaseUrl: base,
      translateUpstream: geminiTranslator(base, "gemini-2.0-flash", "KEY"),
    });

    const response = await rawRequest(proxy.origin, "/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "6*7?" }],
      }),
    });

    expect(lastRequest?.path).toBe(
      "/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=KEY",
    );
    expect(response.status).toBe(200);
    expect(String(response.headers["content-type"])).toContain("text/event-stream");
    const sse = response.body.toString("utf8");
    const types = [...sse.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(types[0]).toBe("message_start");
    expect(types.at(-1)).toBe("message_stop");
    const text = [...sse.matchAll(/"text_delta","text":"([^"]*)"/g)].map((m) => m[1]).join("");
    expect(text).toBe("42");
  });
});
