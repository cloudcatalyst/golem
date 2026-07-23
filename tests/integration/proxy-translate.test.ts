/**
 * R6.1 case (b) slice b1 — the proxy's response-transform seam. A fake
 * OpenAI-schema upstream receives a translated (OpenAI Chat Completions) request
 * and returns an OpenAI completion; the proxy must hand the client back an
 * Anthropic Messages response. Proves the seam only activates when configured
 * (the Anthropic path stays a raw byte pipe, covered elsewhere).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  anthropicToOpenAIChat,
  createOpenAIToAnthropicSSE,
  openAIChatToAnthropic,
} from "../../src/providers/index.js";
import type { UpstreamTranslator } from "../../src/proxy/index.js";
import {
  type FakeUpstream,
  type RunningProxy,
  rawRequest,
  startProxy,
  startUpstream,
} from "./helpers/test-servers.js";

function ollamaTranslator(path: string, model: string): UpstreamTranslator {
  const fallback = { id: "msg_fallback", model };
  return {
    path,
    translateRequest: (body) => {
      const req = anthropicToOpenAIChat(body, { model });
      return { body: Buffer.from(JSON.stringify(req)), stream: req.stream };
    },
    translateResponse: (body) => Buffer.from(JSON.stringify(openAIChatToAnthropic(body, fallback))),
    createStreamTranslator: () => createOpenAIToAnthropicSSE(fallback),
  };
}

describe("proxy OpenAI-schema translation seam (R6.1 case b, b1)", () => {
  let upstream: FakeUpstream;
  let proxy: RunningProxy;
  let lastRequest: { path: string; body: unknown } | null = null;

  beforeEach(async () => {
    lastRequest = null;
    upstream = await startUpstream((req, res, body) => {
      lastRequest = { path: req.url ?? "", body: JSON.parse(body.toString("utf8") || "{}") };
      // A minimal OpenAI Chat Completions response.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-99",
          model: "qwen2.5-coder:7b",
          choices: [
            { message: { role: "assistant", content: "42" }, finish_reason: "stop", index: 0 },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 1 },
        }),
      );
    });
    proxy = await startProxy({
      upstreamBaseUrl: `${upstream.origin}/v1`,
      translateUpstream: ollamaTranslator("/v1/chat/completions", "qwen2.5-coder:7b"),
    });
  });

  afterEach(async () => {
    await proxy.close();
    await upstream.close();
  });

  it("translates an Anthropic request to OpenAI and the response back to Anthropic", async () => {
    const response = await rawRequest(proxy.origin, "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "what is 6*7?" }],
      }),
    });

    // Upstream saw an OpenAI Chat Completions request at the translated path.
    expect(lastRequest?.path).toBe("/v1/chat/completions");
    const sent = lastRequest?.body as { model: string; stream: boolean; messages: unknown[] };
    expect(sent.model).toBe("qwen2.5-coder:7b");
    expect(sent.stream).toBe(false);
    expect(sent.messages).toEqual([{ role: "user", content: "what is 6*7?" }]);

    // Client got an Anthropic Messages response.
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body.toString("utf8"));
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.model).toBe("qwen2.5-coder:7b"); // honest: the real serving model
    expect(body.content).toEqual([{ type: "text", text: "42" }]);
    expect(body.stop_reason).toBe("end_turn");
    expect(body.usage).toEqual({ input_tokens: 7, output_tokens: 1 });
  });

  it("surfaces an upstream error body/status unchanged", async () => {
    await upstream.close();
    upstream = await startUpstream((_req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limited" } }));
    });
    await proxy.close();
    proxy = await startProxy({
      upstreamBaseUrl: `${upstream.origin}/v1`,
      translateUpstream: ollamaTranslator("/v1/chat/completions", "m"),
    });
    const response = await rawRequest(proxy.origin, "/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-x", max_tokens: 1, messages: [] }),
    });
    expect(response.status).toBe(429);
    expect(JSON.parse(response.body.toString("utf8")).error.message).toBe("rate limited");
  });

  it("returns a 400 proxy error when the request cannot be translated", async () => {
    const response = await rawRequest(proxy.origin, "/v1/messages", {
      method: "POST",
      body: "not json at all",
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body.toString("utf8")).error.type).toBe("api_error");
  });

  it("streams: an OpenAI SSE upstream is translated to an Anthropic SSE stream (b2)", async () => {
    await upstream.close();
    upstream = await startUpstream((req, res, body) => {
      lastRequest = { path: req.url ?? "", body: JSON.parse(body.toString("utf8") || "{}") };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        'data: {"id":"c1","model":"qwen2.5-coder:7b","choices":[{"delta":{"role":"assistant"}}]}\n\n',
      );
      res.write('data: {"choices":[{"delta":{"content":"4"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"2"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      res.write('data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });
    await proxy.close();
    proxy = await startProxy({
      upstreamBaseUrl: `${upstream.origin}/v1`,
      translateUpstream: ollamaTranslator("/v1/chat/completions", "qwen2.5-coder:7b"),
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

    expect(response.status).toBe(200);
    expect(String(response.headers["content-type"])).toContain("text/event-stream");
    // Upstream received a streaming OpenAI request.
    const sent = lastRequest?.body as { stream: boolean };
    expect(sent.stream).toBe(true);

    // Client got a well-formed Anthropic SSE stream.
    const sse = response.body.toString("utf8");
    const types = [...sse.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(types).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const text = [...sse.matchAll(/"text_delta","text":"([^"]*)"/g)].map((m) => m[1]).join("");
    expect(text).toBe("42");
  });
});
