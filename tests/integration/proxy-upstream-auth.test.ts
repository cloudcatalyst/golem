/**
 * R6.1 case (a) — the proxy's upstream auth-header mapping. Proves that for a
 * non-Anthropic Anthropic-protocol upstream the client's Anthropic credential
 * is stripped and the configured provider credential is injected, while the
 * body and other end-to-end headers pass through byte-faithfully. The default
 * (no mapper) forwards the client's own auth verbatim.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeAuthMapper } from "../../src/providers/index.js";
import {
  type FakeUpstream,
  type RunningProxy,
  rawRequest,
  startProxy,
  startUpstream,
} from "./helpers/test-servers.js";

describe("proxy upstream auth mapping (R6.1 case a)", () => {
  let upstream: FakeUpstream;
  let azure: RunningProxy; // api-key scheme
  let bearer: RunningProxy; // bearer scheme

  beforeAll(async () => {
    upstream = await startUpstream((req, res, body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ headers: req.headers, bodyUtf8: body.toString("utf8") }));
    });
    azure = await startProxy({
      upstreamBaseUrl: upstream.origin,
      // biome-ignore lint/style/noNonNullAssertion: scheme+key always yields a mapper
      mapUpstreamHeaders: makeAuthMapper("api-key", "azure-secret")!,
    });
    bearer = await startProxy({
      upstreamBaseUrl: upstream.origin,
      // biome-ignore lint/style/noNonNullAssertion: scheme+key always yields a mapper
      mapUpstreamHeaders: makeAuthMapper("bearer", "or-key")!,
    });
  });

  afterAll(async () => {
    await azure.close();
    await bearer.close();
    await upstream.close();
  });

  it("api-key: swaps the client's x-api-key for the Azure api-key, body untouched", async () => {
    const response = await rawRequest(azure.origin, "/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": "sk-ant-client-key",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: '{"model":"claude-opus-4-5"}',
    });
    const { headers, bodyUtf8 } = JSON.parse(response.body.toString("utf8"));
    expect(headers["api-key"]).toBe("azure-secret");
    expect(headers["x-api-key"]).toBeUndefined();
    // End-to-end headers and body are byte-faithful.
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(bodyUtf8).toBe('{"model":"claude-opus-4-5"}');
  });

  it("bearer: injects Authorization: Bearer and drops the client x-api-key", async () => {
    const response = await rawRequest(bearer.origin, "/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "sk-ant-client-key" },
      body: "{}",
    });
    const { headers } = JSON.parse(response.body.toString("utf8"));
    expect(headers.authorization).toBe("Bearer or-key");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("still maps auth on an x-golem-bypass request (upstream needs valid creds)", async () => {
    const response = await rawRequest(azure.origin, "/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "sk-ant-client-key", "x-golem-bypass": "true" },
      body: "{}",
    });
    const { headers } = JSON.parse(response.body.toString("utf8"));
    expect(headers["api-key"]).toBe("azure-secret");
    expect(headers["x-api-key"]).toBeUndefined();
  });
});
