/**
 * R11.7 — the proxy says what became of each request, and can see a truncated
 * stream.
 *
 * The gap this closes: `.golem/proxy.log` recorded the routing decision taken
 * BEFORE forwarding and nothing afterwards, so a request that died mid-stream
 * was indistinguishable from one that succeeded. Diagnosing a live
 * "Connection lost mid-response" had to be done from the client's own transcript
 * and the process table instead of from the proxy that handled it.
 *
 * The signal only the proxy can see: an Anthropic Messages stream ends with
 * `message_stop`. One that stops without it — and without an `error` event to
 * explain why — was truncated.
 *
 * Every case here also asserts the relayed bytes, because observation must never
 * change what reaches the client (CLAUDE.md proxy-fidelity rule).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProxyRequestOutcome } from "../../src/proxy/types.js";
import { SSE_STREAM_FIXTURE } from "./helpers/anthropic-fixtures.js";
import {
  type FakeUpstream,
  type RunningProxy,
  rawRequest,
  startProxy,
  startUpstream,
} from "./helpers/test-servers.js";

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
} as const;

/**
 * The recorded stream with its terminator cut off: everything up to (but not
 * including) `event: message_stop`. Exactly the shape a dropped socket leaves.
 */
const TRUNCATED_STREAM = SSE_STREAM_FIXTURE.slice(
  0,
  SSE_STREAM_FIXTURE.indexOf("event: message_stop"),
);

describe("proxy request outcomes (R11.7)", () => {
  let upstream: FakeUpstream;
  let proxy: RunningProxy;
  let outcomes: ProxyRequestOutcome[];

  beforeAll(async () => {
    upstream = await startUpstream(async (req, res) => {
      const fixture = req.headers["x-fixture"];
      if (fixture === "full-stream") {
        res.writeHead(200, SSE_HEADERS);
        res.end(SSE_STREAM_FIXTURE);
        return;
      }
      if (fixture === "truncated-stream") {
        res.writeHead(200, SSE_HEADERS);
        // A stream that simply stops: no message_stop, no error event.
        res.end(TRUNCATED_STREAM);
        return;
      }
      if (fixture === "json") {
        const body = JSON.stringify({ type: "message", content: [] });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
        return;
      }
      if (fixture === "upstream-500") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"type":"error"}');
        return;
      }
      res.writeHead(404).end();
    });
    outcomes = [];
    proxy = await startProxy({
      upstreamBaseUrl: upstream.origin,
      onRequestOutcome: (outcome) => outcomes.push(outcome),
    });
  });

  afterAll(async () => {
    await proxy.close();
    await upstream.close();
  });

  const send = async (fixture: string): Promise<Buffer> => {
    outcomes.length = 0;
    const response = await rawRequest(proxy.origin, "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-fixture": fixture },
      body: JSON.stringify({ model: "claude-opus-5", messages: [] }),
    });
    return response.body;
  };

  it("reports a completed stream as ok, and relays it byte-identically", async () => {
    const body = await send("full-stream");

    expect(body.toString("utf8")).toBe(SSE_STREAM_FIXTURE);
    expect(outcomes).toHaveLength(1);
    const [outcome] = outcomes;
    expect(outcome?.result).toBe("ok");
    expect(outcome?.status).toBe(200);
    expect(outcome?.streaming).toBe(true);
    expect(outcome?.method).toBe("POST");
    expect(outcome?.path).toBe("/v1/messages");
    expect(outcome?.bytes).toBe(Buffer.byteLength(SSE_STREAM_FIXTURE));
    expect(outcome?.events).toBeGreaterThan(0);
    expect(outcome?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a stream that ended without message_stop as TRUNCATED", async () => {
    const body = await send("truncated-stream");

    // Fidelity first: the client still receives exactly what the upstream sent.
    expect(body.toString("utf8")).toBe(TRUNCATED_STREAM);
    expect(outcomes).toHaveLength(1);
    const [outcome] = outcomes;
    expect(outcome?.result).toBe("truncated");
    expect(outcome?.streaming).toBe(true);
    expect(outcome?.status).toBe(200);
    // It names where the stream stopped, so the log line is actionable.
    expect(outcome?.lastEvent).toBeDefined();
    expect(outcome?.lastEvent).not.toBe("message_stop");
    expect(outcome?.detail).toContain("no message_stop");
  });

  it("does not call a non-streaming JSON response truncated", async () => {
    await send("json");

    expect(outcomes[0]?.result).toBe("ok");
    expect(outcomes[0]?.streaming).toBe(false);
    // `events` is meaningless off the SSE path, so it is not reported at all.
    expect(outcomes[0]?.events).toBeUndefined();
  });

  it("reports an upstream non-2xx as upstream_error, not as ok", async () => {
    await send("upstream-500");

    expect(outcomes[0]?.result).toBe("upstream_error");
    expect(outcomes[0]?.status).toBe(500);
  });

  it("reports exactly one outcome per request", async () => {
    await send("full-stream");
    expect(outcomes).toHaveLength(1);
    await send("truncated-stream");
    expect(outcomes).toHaveLength(1);
  });
});

describe("the outcome hook is optional (R11.7)", () => {
  it("relays byte-identically with no hook — the sniffer is not constructed", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, SSE_HEADERS);
      res.end(SSE_STREAM_FIXTURE);
    });
    const proxy = await startProxy({ upstreamBaseUrl: upstream.origin });
    try {
      const response = await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(response.body.toString("utf8")).toBe(SSE_STREAM_FIXTURE);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});
