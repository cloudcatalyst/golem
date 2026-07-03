/**
 * WS-A A1 — non-streaming passthrough: JSON responses, request fidelity,
 * upstream error status relaying, and base-URL path prefixes.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NON_STREAMING_TOOL_USE_RESPONSE } from "./helpers/anthropic-fixtures.js";
import {
  type FakeUpstream,
  type RunningProxy,
  rawRequest,
  startProxy,
  startUpstream,
} from "./helpers/test-servers.js";

const RATE_LIMIT_BODY = JSON.stringify({
  type: "error",
  error: { type: "rate_limit_error", message: "Number of requests has exceeded your rate limit" },
  request_id: "req_011CSHoEeqs5C35K2UUqR7Fy",
});

describe("proxy non-streaming passthrough", () => {
  let upstream: FakeUpstream;
  let proxy: RunningProxy;

  beforeAll(async () => {
    upstream = await startUpstream((req, res, body) => {
      if (req.url?.startsWith("/echo")) {
        const payload = JSON.stringify({
          method: req.method,
          url: req.url,
          bodyBase64: body.toString("base64"),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(payload);
        return;
      }
      if (req.url === "/v1/messages" && req.headers["x-fixture"] === "rate-limited") {
        res.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "13",
          "request-id": "req_011CSHoEeqs5C35K2UUqR7Fy",
        });
        res.end(RATE_LIMIT_BODY);
        return;
      }
      if (req.url === "/v1/messages") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(NON_STREAMING_TOOL_USE_RESPONSE);
        return;
      }
      res.writeHead(404).end();
    });
    proxy = await startProxy({ upstreamBaseUrl: upstream.origin });
  });

  afterAll(async () => {
    await proxy.close();
    await upstream.close();
  });

  it("relays non-streaming JSON byte-identically and semantically intact", async () => {
    const response = await rawRequest(proxy.origin, "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"claude-opus-4-8","max_tokens":64,"messages":[]}',
    });

    expect(response.status).toBe(200);
    // No re-serialization anywhere on the path.
    expect(response.body.equals(Buffer.from(NON_STREAMING_TOOL_USE_RESPONSE))).toBe(true);

    // Semantic identity, including tool_use block and cache usage fields.
    const message = JSON.parse(response.body.toString("utf8"));
    expect(message).toStrictEqual(JSON.parse(NON_STREAMING_TOOL_USE_RESPONSE));
    expect(message.content[1]).toStrictEqual({
      type: "tool_use",
      id: "toolu_01T1x1fJ34qAmk2tNTrN7Up6",
      name: "get_weather",
      input: { location: "Paris, France", unit: "celsius" },
    });
    expect(message.usage.cache_read_input_tokens).toBe(1024);
  });

  it("forwards method, path, query and body bytes unchanged", async () => {
    const body = Buffer.from('{"prompt":"héllo — 日本語 🚀","cache_control":{"type":"ephemeral"}}');
    const response = await rawRequest(proxy.origin, "/echo/v1/messages?beta=true&x=%20y", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(response.status).toBe(200);
    const echoed = JSON.parse(response.body.toString("utf8"));
    expect(echoed.method).toBe("POST");
    expect(echoed.url).toBe("/echo/v1/messages?beta=true&x=%20y");
    expect(Buffer.from(echoed.bodyBase64, "base64").equals(body)).toBe(true);
  });

  it("supports token-counting and other endpoints transparently", async () => {
    const response = await rawRequest(proxy.origin, "/echo/v1/messages/count_tokens", {
      method: "POST",
      body: "{}",
    });
    const echoed = JSON.parse(response.body.toString("utf8"));
    expect(echoed.url).toBe("/echo/v1/messages/count_tokens");
  });

  it("honors an upstream base URL that carries a path prefix", async () => {
    const prefixed = await startProxy({ upstreamBaseUrl: `${upstream.origin}/echo/gateway/` });
    try {
      const response = await rawRequest(prefixed.origin, "/v1/messages", { method: "POST" });
      const echoed = JSON.parse(response.body.toString("utf8"));
      expect(echoed.url).toBe("/echo/gateway/v1/messages");
    } finally {
      await prefixed.close();
    }
  });

  it("relays upstream HTTP errors (status, headers, body) untouched", async () => {
    const response = await rawRequest(proxy.origin, "/v1/messages", {
      method: "POST",
      headers: { "x-fixture": "rate-limited" },
    });

    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("13");
    expect(response.headers["request-id"]).toBe("req_011CSHoEeqs5C35K2UUqR7Fy");
    // Not a proxy-generated error:
    expect(response.headers["x-golem-error"]).toBeUndefined();
    expect(response.body.equals(Buffer.from(RATE_LIMIT_BODY))).toBe(true);
  });
});
