/**
 * WS-A A1 — upstream failure mapping: connection errors -> 502,
 * timeouts -> 504, pipeline failures -> 500. Proxy-generated errors carry
 * the x-golem-error marker and an Anthropic-shaped JSON body.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestPipeline } from "../../src/proxy/index.js";
import {
  type FakeUpstream,
  type RunningProxy,
  rawRequest,
  startProxy,
  startUpstream,
} from "./helpers/test-servers.js";

/** Find a port with nothing listening on it. */
async function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

describe("proxy upstream error mapping", () => {
  it("maps upstream connection refusal to 502 with an Anthropic-shaped body", async () => {
    const port = await closedPort();
    const proxy = await startProxy({ upstreamBaseUrl: `http://127.0.0.1:${port}` });
    try {
      const response = await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        body: "{}",
      });
      expect(response.status).toBe(502);
      expect(response.headers["x-golem-error"]).toBe("true");
      expect(response.headers["content-type"]).toBe("application/json");
      const body = JSON.parse(response.body.toString("utf8"));
      expect(body.type).toBe("error");
      expect(body.error.type).toBe("api_error");
      expect(body.error.message).toContain("golem proxy: upstream connection failed");
    } finally {
      await proxy.close();
    }
  });

  describe("with a silent upstream", () => {
    let upstream: FakeUpstream;
    let proxy: RunningProxy;

    beforeAll(async () => {
      // Accepts connections but never sends response headers.
      upstream = await startUpstream(() => {
        /* never respond */
      });
      proxy = await startProxy({
        upstreamBaseUrl: upstream.origin,
        headersTimeoutMs: 150,
      });
    });

    afterAll(async () => {
      await proxy.close();
      await upstream.close();
    });

    it("maps the configured headers timeout to 504", async () => {
      const response = await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        body: "{}",
      });
      expect(response.status).toBe(504);
      expect(response.headers["x-golem-error"]).toBe("true");
      const body = JSON.parse(response.body.toString("utf8"));
      expect(body.error.type).toBe("api_error");
      expect(body.error.message).toContain("timed out");
    });
  });

  it("maps a pipeline failure to 500 without contacting the upstream", async () => {
    let upstreamHit = false;
    const upstream = await startUpstream((_req, res) => {
      upstreamHit = true;
      res.writeHead(200).end("{}");
    });
    const failing: RequestPipeline = {
      name: "failing",
      process: () => Promise.reject(new Error("redaction stage exploded")),
    };
    const proxy = await startProxy({ upstreamBaseUrl: upstream.origin, pipeline: failing });
    try {
      const response = await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        body: "{}",
      });
      expect(response.status).toBe(500);
      expect(response.headers["x-golem-error"]).toBe("true");
      const body = JSON.parse(response.body.toString("utf8"));
      expect(body.error.message).toContain("request pipeline failed");
      expect(upstreamHit).toBe(false);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("bypass requests still reach the upstream when the pipeline is broken", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    const failing: RequestPipeline = {
      name: "failing",
      process: () => Promise.reject(new Error("boom")),
    };
    const proxy = await startProxy({ upstreamBaseUrl: upstream.origin, pipeline: failing });
    try {
      const response = await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        headers: { "x-golem-bypass": "true" },
        body: "{}",
      });
      // Bypass never touches the pipeline, so it survives pipeline bugs.
      expect(response.status).toBe(200);
      expect(response.body.toString("utf8")).toBe('{"ok":true}');
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});
