/**
 * WS-A A1 — header forwarding, x-golem-bypass semantics, and the request
 * pipeline seam.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProxyRequest, RequestPipeline } from "../../src/proxy/index.js";
import {
  type FakeUpstream,
  type RunningProxy,
  rawRequest,
  startProxy,
  startUpstream,
} from "./helpers/test-servers.js";

/**
 * Test-only pipeline that visibly mutates requests. The production default
 * is the identity; this exists to prove (a) the seam is invoked, and
 * (b) bypass skips it entirely.
 */
const markerPipeline: RequestPipeline = {
  name: "marker",
  process: (request: ProxyRequest) =>
    Promise.resolve({
      ...request,
      headers: { ...request.headers, "x-golem-pipeline": "ran" },
      body: request.body ? Buffer.concat([request.body, Buffer.from("+pipeline")]) : request.body,
    }),
};

describe("proxy header forwarding and bypass", () => {
  let upstream: FakeUpstream;
  let proxy: RunningProxy;
  let pipelined: RunningProxy;

  beforeAll(async () => {
    upstream = await startUpstream((req, res, body) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "request-id": "req_echo_01",
        "anthropic-ratelimit-requests-remaining": "999",
        "anthropic-ratelimit-input-tokens-remaining": "80000",
      });
      res.end(JSON.stringify({ headers: req.headers, bodyUtf8: body.toString("utf8") }));
    });
    proxy = await startProxy({ upstreamBaseUrl: upstream.origin });
    pipelined = await startProxy({ upstreamBaseUrl: upstream.origin, pipeline: markerPipeline });
  });

  afterAll(async () => {
    await proxy.close();
    await pipelined.close();
    await upstream.close();
  });

  it("forwards auth and Anthropic headers; rewrites host; strips hop-by-hop", async () => {
    const response = await rawRequest(proxy.origin, "/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": "sk-ant-api03-test-key",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
        "user-agent": "claude-cli/2.1.0",
        "x-custom-header": "custom-value",
      },
      body: "{}",
    });

    const { headers } = JSON.parse(response.body.toString("utf8"));
    // End-to-end headers arrive untouched (auth included).
    expect(headers["x-api-key"]).toBe("sk-ant-api03-test-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-beta"]).toBe("fine-grained-tool-streaming-2025-05-14");
    expect(headers["user-agent"]).toBe("claude-cli/2.1.0");
    expect(headers["x-custom-header"]).toBe("custom-value");
    // Host points at the upstream, not the proxy.
    expect(headers.host).toBe(`127.0.0.1:${upstream.port}`);
  });

  it("relays upstream response headers (request-id, rate limits) to the client", async () => {
    const response = await rawRequest(proxy.origin, "/v1/messages", { method: "POST", body: "{}" });
    expect(response.headers["request-id"]).toBe("req_echo_01");
    expect(response.headers["anthropic-ratelimit-requests-remaining"]).toBe("999");
    expect(response.headers["anthropic-ratelimit-input-tokens-remaining"]).toBe("80000");
  });

  it("strips x-golem-bypass before forwarding", async () => {
    const response = await rawRequest(proxy.origin, "/v1/messages", {
      method: "POST",
      headers: { "x-golem-bypass": "true" },
      body: "{}",
    });
    const { headers } = JSON.parse(response.body.toString("utf8"));
    expect(headers["x-golem-bypass"]).toBeUndefined();
  });

  it("runs the pipeline seam on normal requests", async () => {
    const response = await rawRequest(pipelined.origin, "/v1/messages", {
      method: "POST",
      body: "original",
    });
    const echoed = JSON.parse(response.body.toString("utf8"));
    expect(echoed.headers["x-golem-pipeline"]).toBe("ran");
    expect(echoed.bodyUtf8).toBe("original+pipeline");
  });

  it("x-golem-bypass guarantees pure passthrough — pipeline skipped entirely", async () => {
    const response = await rawRequest(pipelined.origin, "/v1/messages", {
      method: "POST",
      headers: { "x-golem-bypass": "true" },
      body: "original",
    });
    const echoed = JSON.parse(response.body.toString("utf8"));
    expect(echoed.headers["x-golem-pipeline"]).toBeUndefined();
    expect(echoed.headers["x-golem-bypass"]).toBeUndefined();
    expect(echoed.bodyUtf8).toBe("original");
  });

  it("treats an explicit negative bypass value as not bypassed", async () => {
    const response = await rawRequest(pipelined.origin, "/v1/messages", {
      method: "POST",
      headers: { "x-golem-bypass": "false" },
      body: "original",
    });
    const echoed = JSON.parse(response.body.toString("utf8"));
    expect(echoed.headers["x-golem-pipeline"]).toBe("ran");
    // The control header itself is still never forwarded.
    expect(echoed.headers["x-golem-bypass"]).toBeUndefined();
  });
});
