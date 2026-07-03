/**
 * WS-A A1 — SSE streaming passthrough must be byte-faithful.
 *
 * The fake upstream serves recorded Anthropic streaming shapes
 * (verification-notes §15) split at hostile chunk boundaries (mid-line,
 * mid-JSON-escape, mid-UTF-8 codepoint). The proxy output must be
 * byte-identical to the fixture, and must stream (not buffer).
 */

import { Client } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chunkify,
  SSE_ERROR_STREAM_FIXTURE,
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

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
} as const;

// Sizes chosen to split mid-`event:` line, mid-escape and mid-codepoint.
const HOSTILE_CHUNK_SIZES = [7, 1, 3, 2, 11, 5, 64, 1, 129] as const;

describe("proxy SSE streaming passthrough", () => {
  let upstream: FakeUpstream;
  let proxy: RunningProxy;
  let gateResolve: (() => void) | undefined;

  beforeAll(async () => {
    upstream = await startUpstream(async (req, res) => {
      if (req.url === "/v1/messages" && req.headers["x-fixture"] === "full-stream") {
        res.writeHead(200, SSE_HEADERS);
        await writeChunked(res, chunkify(Buffer.from(SSE_STREAM_FIXTURE), HOSTILE_CHUNK_SIZES));
        return;
      }
      if (req.url === "/v1/messages" && req.headers["x-fixture"] === "error-stream") {
        res.writeHead(200, SSE_HEADERS);
        await writeChunked(res, chunkify(Buffer.from(SSE_ERROR_STREAM_FIXTURE), [13, 2, 40]));
        return;
      }
      if (req.url === "/v1/messages" && req.headers["x-fixture"] === "gated-stream") {
        res.writeHead(200, SSE_HEADERS);
        const fixture = Buffer.from(SSE_STREAM_FIXTURE);
        const half = Math.floor(fixture.length / 2);
        res.write(fixture.subarray(0, half));
        // Hold the tail until the test confirms the head arrived at the
        // client — proves the proxy streams instead of buffering.
        await new Promise<void>((resolve) => {
          gateResolve = resolve;
        });
        res.end(fixture.subarray(half));
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

  it("relays the full recorded stream byte-identically under hostile chunking", async () => {
    const response = await rawRequest(proxy.origin, "/v1/messages", {
      method: "POST",
      headers: { "x-fixture": "full-stream", "content-type": "application/json" },
      body: '{"model":"claude-opus-4-8","stream":true,"max_tokens":64,"messages":[]}',
    });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    // Byte-for-byte fidelity: every event (thinking_delta, signature_delta,
    // input_json_delta fragments, server_tool_use, web_search_tool_result,
    // tool_reference, ping) untouched, in order.
    expect(response.body.equals(Buffer.from(SSE_STREAM_FIXTURE))).toBe(true);
  });

  it("preserves tool_use blocks and partial input_json_delta fragments exactly", async () => {
    const response = await rawRequest(proxy.origin, "/v1/messages", {
      method: "POST",
      headers: { "x-fixture": "full-stream" },
    });
    const text = response.body.toString("utf8");

    // The partial JSON fragments must appear verbatim — unmerged, unparsed,
    // not re-serialized (their concatenation, not the fragments, is JSON).
    expect(text).toContain('{"type":"input_json_delta","partial_json":"{\\"loc"}');
    expect(text).toContain('{"type":"input_json_delta","partial_json":"ation\\": \\"Par"}');
    expect(text).toContain(
      '{"type":"input_json_delta","partial_json":"is, France\\", \\"unit\\": \\"celsius\\"}"}',
    );
    // tool_reference and server tool results pass through (notes §12).
    expect(text).toContain('"content_block":{"type":"tool_reference","tool_name":"get_time"}');
    expect(text).toContain('"type":"web_search_tool_result"');
    // signature_delta (thinking integrity) untouched.
    expect(text).toContain('"type":"signature_delta"');
  });

  it("passes SSE error events through immediately and byte-identically", async () => {
    const response = await rawRequest(proxy.origin, "/v1/messages", {
      method: "POST",
      headers: { "x-fixture": "error-stream" },
    });
    expect(response.status).toBe(200);
    expect(response.body.equals(Buffer.from(SSE_ERROR_STREAM_FIXTURE))).toBe(true);
  });

  it("streams incrementally instead of buffering the response", async () => {
    const client = new Client(proxy.origin);
    try {
      const response = await client.request({
        path: "/v1/messages",
        method: "POST",
        headers: { "x-fixture": "gated-stream" },
      });
      expect(response.statusCode).toBe(200);

      const received: Buffer[] = [];
      let releasedTail = false;
      for await (const chunk of response.body) {
        received.push(Buffer.from(chunk as Uint8Array));
        const soFar = Buffer.concat(received).length;
        // The upstream is still holding the second half open: any bytes here
        // prove the proxy forwards chunks as they arrive.
        if (!releasedTail && soFar > 0) {
          expect(soFar).toBeLessThan(Buffer.from(SSE_STREAM_FIXTURE).length);
          releasedTail = true;
          gateResolve?.();
        }
      }
      expect(releasedTail).toBe(true);
      expect(Buffer.concat(received).equals(Buffer.from(SSE_STREAM_FIXTURE))).toBe(true);
    } finally {
      await client.close();
    }
  });
});
