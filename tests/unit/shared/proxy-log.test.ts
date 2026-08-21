/**
 * R11.7 — the log line, and the shape of an outcome record.
 *
 * The reason this file exists: `.golem/proxy.log` had 11,655 lines with no
 * timestamp on any of them, so it could not be used to investigate anything.
 * The timestamp and the outcome wording are the product here, which makes them
 * worth pinning rather than leaving to a template literal nobody reads.
 */

import { describe, expect, it } from "vitest";
import {
  proxyLog,
  renderRequestOutcome,
  setProxyLogForTesting,
} from "../../../src/shared/proxy-log.js";

describe("proxyLog", () => {
  it("stamps every line with an ISO-8601 UTC timestamp", () => {
    const lines: string[] = [];
    const restore = setProxyLogForTesting({
      sink: (line) => lines.push(line),
      clock: () => new Date("2026-08-21T02:21:04.843Z"),
    });
    try {
      proxyLog('routed to "anthropic" — inference.default_target');
    } finally {
      restore();
    }
    expect(lines).toEqual([
      '2026-08-21T02:21:04.843Z golem proxy: routed to "anthropic" — inference.default_target\n',
    ]);
  });

  it("never throws when the sink fails — a log must not break a request", () => {
    const restore = setProxyLogForTesting({
      sink: () => {
        throw new Error("stderr is gone");
      },
    });
    try {
      expect(() => proxyLog("anything")).not.toThrow();
    } finally {
      restore();
    }
  });
});

describe("renderRequestOutcome", () => {
  const base = {
    method: "POST",
    path: "/v1/messages",
    durationMs: 12_340,
    bytes: 46_285,
    streaming: true,
    result: "ok",
  };

  it("names the target, status, duration, bytes and event count", () => {
    const line = renderRequestOutcome({
      ...base,
      targetId: "anthropic",
      status: 200,
      events: 412,
    });
    expect(line).toBe("POST /v1/messages → anthropic 200 — OK in 12.3s, 45.2 KB, 412 SSE events");
  });

  it("shouts TRUNCATED, and says where the stream stopped and why", () => {
    const line = renderRequestOutcome({
      ...base,
      targetId: "anthropic",
      status: 200,
      events: 400,
      result: "truncated",
      lastEvent: "content_block_delta",
      detail: "the SSE stream ended with no message_stop and no error event",
    });
    expect(line).toContain("TRUNCATED");
    expect(line).toContain("(last event: content_block_delta)");
    expect(line).toContain("no message_stop");
  });

  it("keeps a sub-second request in milliseconds, and omits an empty body", () => {
    const line = renderRequestOutcome({
      ...base,
      durationMs: 87,
      bytes: 0,
      streaming: false,
      status: 200,
    });
    expect(line).toContain("in 87ms");
    expect(line).not.toContain(" B");
    expect(line).not.toContain("SSE events");
  });

  it("works with no target and no status (a request that never got either)", () => {
    const line = renderRequestOutcome({
      ...base,
      result: "client_gone",
      bytes: 0,
      streaming: false,
      detail: "the client hung up before the upstream answered",
    });
    expect(line).toBe(
      "POST /v1/messages — CLIENT_GONE in 12.3s: the client hung up before the upstream answered",
    );
  });
});
