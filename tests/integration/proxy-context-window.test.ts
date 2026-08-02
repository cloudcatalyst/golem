/**
 * R6.1 case (b) context-window gate — simulates an Anthropic
 * `context_length_exceeded` error when the request exceeds the upstream
 * model's real context window, so Claude Code triggers its own compaction
 * instead of the upstream rejecting mid-stream.
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

function makeTranslator(model: string): UpstreamTranslator {
  const fallback = { id: "msg_fallback", model };
  return {
    path: "/v1/chat/completions",
    translateRequest: (body) => {
      const req = anthropicToOpenAIChat(body, { model });
      return { body: Buffer.from(JSON.stringify(req)), stream: req.stream };
    },
    translateResponse: (body) => Buffer.from(JSON.stringify(openAIChatToAnthropic(body, fallback))),
    createStreamTranslator: () => createOpenAIToAnthropicSSE(fallback),
  };
}

describe("proxy context-window gate (R6.1 case b)", () => {
  let upstream: FakeUpstream;
  let proxy: RunningProxy;
  let lastForwarded: boolean = false;

  beforeEach(async () => {
    lastForwarded = false;
    upstream = await startUpstream((_req, res) => {
      lastForwarded = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-99",
          model: "test-model",
          choices: [
            { message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 1 },
        }),
      );
    });
  });

  afterEach(async () => {
    await proxy.close();
    await upstream.close();
  });

  it("returns 400 context_length_exceeded when request exceeds the upstream's window", async () => {
    // Build a request body that will exceed 90% of a 1000-token window.
    // The request body includes a large messages array (~1250 tokens).
    const largeMessage = "A".repeat(5000);
    const body = JSON.stringify({
      model: "claude-opus-5",
      max_tokens: 100,
      messages: [{ role: "user", content: largeMessage }],
    });

    // A checkContextWindow that simulates a 1000-token upstream window
    proxy = await startProxy({
      upstreamBaseUrl: `${upstream.origin}/v1`,
      translateUpstream: makeTranslator("test-model"),
      checkContextWindow: () =>
        Promise.resolve({
          shouldReject: (reqBody: Buffer | null) => {
            if (reqBody === null) return false;
            const bytes = reqBody.length;
            const estTokens = Math.ceil(bytes / 4);
            return estTokens > 900; // 90% of 1000
          },
          contextWindow: 1000,
        }),
    });

    const response = await rawRequest(proxy.origin, "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(response.status).toBe(400);
    const parsed = JSON.parse(response.body.toString("utf8"));
    expect(parsed.type).toBe("error");
    expect(parsed.error.type).toBe("context_length_exceeded");
    // The upstream should NOT have been called
    expect(lastForwarded).toBe(false);
  });

  it("forwards normally when request fits within the upstream's window", async () => {
    const smallBody = JSON.stringify({
      model: "claude-opus-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "what is 2+2?" }],
    });

    proxy = await startProxy({
      upstreamBaseUrl: `${upstream.origin}/v1`,
      translateUpstream: makeTranslator("test-model"),
      checkContextWindow: () =>
        Promise.resolve({
          shouldReject: (reqBody: Buffer | null) => {
            if (reqBody === null) return false;
            const bytes = reqBody.length;
            const estTokens = Math.ceil(bytes / 4);
            return estTokens > 900; // 90% of 1000
          },
          contextWindow: 1000,
        }),
    });

    const response = await rawRequest(proxy.origin, "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: smallBody,
    });

    expect(response.status).toBe(200);
    expect(lastForwarded).toBe(true);
  });

  it("fails open (forwards normally) when checkContextWindow returns null window", async () => {
    const smallBody = JSON.stringify({
      model: "claude-opus-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "what is 2+2?" }],
    });

    proxy = await startProxy({
      upstreamBaseUrl: `${upstream.origin}/v1`,
      translateUpstream: makeTranslator("test-model"),
      checkContextWindow: () =>
        Promise.resolve({
          shouldReject: () => false, // unknown window → never reject
          contextWindow: null,
        }),
    });

    const response = await rawRequest(proxy.origin, "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: smallBody,
    });

    expect(response.status).toBe(200);
  });

  it("does not check context window for non-messages POST endpoints", async () => {
    let checkCalled = false;
    proxy = await startProxy({
      upstreamBaseUrl: `${upstream.origin}/v1`,
      translateUpstream: makeTranslator("test-model"),
      checkContextWindow: () => {
        checkCalled = true;
        return Promise.resolve({
          shouldReject: () => true,
          contextWindow: 1000,
        });
      },
    });

    // A POST to /v1/batches (not /v1/messages) should not trigger the check
    await rawRequest(proxy.origin, "/v1/batches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-5", max_tokens: 10, messages: [] }),
    });

    // The proxy forwards the POST (not a /v1/messages POST), so the check
    // should never have been invoked.
    expect(checkCalled).toBe(false);
  });
});
