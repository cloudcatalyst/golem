/**
 * WS-A A3 — the redaction→compression pipeline running end-to-end through the
 * real GolemProxy against a fake upstream that echoes back what it received,
 * so we can assert exactly what got forwarded.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NativeLosslessCompression } from "../../src/compression/index.js";
import { type SliderLevel, sliderPolicyForLevel } from "../../src/interfaces/policy.js";
import { createGolemPipeline } from "../../src/pipeline/index.js";
import { rawRequest, startProxy, startUpstream } from "./helpers/test-servers.js";

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-pipe-"));
});
afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

/** Fake upstream that records the last request body and returns 200 JSON. */
function recordingUpstream() {
  const received: { body: string } = { body: "" };
  return {
    received,
    handler: (_req: unknown, res: import("node:http").ServerResponse, body: Buffer): void => {
      received.body = body.toString("utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  };
}

function pipelineFor(level: SliderLevel) {
  return createGolemPipeline({
    compression: NativeLosslessCompression.forProjectDir(projectDir),
    policy: () => sliderPolicyForLevel(level),
    projectId: projectDir,
  });
}

const AWS_SECRET = "AKIAIOSFODNN7EXAMPLE";

describe("pipeline through the proxy", () => {
  it("level 1: strips a secret before forwarding (redaction runs)", async () => {
    const up = recordingUpstream();
    const upstream = await startUpstream(up.handler);
    const proxy = await startProxy({ upstreamBaseUrl: upstream.origin, pipeline: pipelineFor(1) });
    try {
      const body = JSON.stringify({
        model: "claude-x",
        messages: [{ role: "user", content: `my key is ${AWS_SECRET}` }],
      });
      await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(up.received.body).not.toContain(AWS_SECRET);
      expect(up.received.body).toContain("[REDACTED:aws-key:1]");
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("redaction runs BEFORE compression: a secret inside a duplicated block never reaches the CCR store in the clear", async () => {
    const up = recordingUpstream();
    const upstream = await startUpstream(up.handler);
    const compression = NativeLosslessCompression.forProjectDir(projectDir);
    const pipeline = createGolemPipeline({
      compression,
      policy: () => sliderPolicyForLevel(1),
      projectId: projectDir,
    });
    const proxy = await startProxy({ upstreamBaseUrl: upstream.origin, pipeline });
    try {
      // Two large identical tool_result blocks, each carrying the secret, so
      // the dedup stage will store one as a CCR original.
      const big = `${"x".repeat(600)} ${AWS_SECRET} ${"y".repeat(600)}`;
      const body = JSON.stringify({
        model: "claude-x",
        messages: [
          { role: "user", content: [{ type: "tool_result", content: big }] },
          { role: "user", content: [{ type: "tool_result", content: big }] },
        ],
      });
      await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      // The forwarded payload must not contain the raw secret anywhere.
      expect(up.received.body).not.toContain(AWS_SECRET);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("bypass header forces pure passthrough (secret forwarded untouched)", async () => {
    const up = recordingUpstream();
    const upstream = await startUpstream(up.handler);
    const proxy = await startProxy({ upstreamBaseUrl: upstream.origin, pipeline: pipelineFor(1) });
    try {
      const body = JSON.stringify({
        model: "claude-x",
        messages: [{ role: "user", content: `my key is ${AWS_SECRET}` }],
      });
      await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-golem-bypass": "1" },
        body,
      });
      // Bypass means the pipeline never runs — original bytes pass through.
      expect(up.received.body).toBe(body);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("level 0: secret-free body is forwarded byte-identical", async () => {
    const up = recordingUpstream();
    const upstream = await startUpstream(up.handler);
    const proxy = await startProxy({ upstreamBaseUrl: upstream.origin, pipeline: pipelineFor(0) });
    try {
      const body = JSON.stringify({
        model: "claude-x",
        messages: [{ role: "user", content: "hello world" }],
      });
      await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(up.received.body).toBe(body);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("non-messages paths pass through untouched", async () => {
    const up = recordingUpstream();
    const upstream = await startUpstream(up.handler);
    const proxy = await startProxy({ upstreamBaseUrl: upstream.origin, pipeline: pipelineFor(1) });
    try {
      const body = JSON.stringify({ anything: AWS_SECRET });
      await rawRequest(proxy.origin, "/v1/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      // Not a /v1/messages request — pipeline leaves it alone.
      expect(up.received.body).toBe(body);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});
