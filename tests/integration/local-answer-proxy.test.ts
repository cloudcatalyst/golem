/**
 * R2.3 (spec Decision 24 sub-mode 2 / Decision 33) — the local-answer
 * sub-mode running end-to-end through the real GolemProxy: a confident
 * result must be served directly (respondDirectly) WITHOUT the upstream ever
 * seeing the request, and the served bytes must be a valid recorded-shape
 * Anthropic Messages response (non-streaming JSON and SSE).
 */

import { describe, expect, it } from "vitest";
import { NativeLosslessCompression } from "../../src/compression/index.js";
import type {
  LocalAnswerQuery,
  LocalAnswerResult,
  LocalAnswerService,
} from "../../src/interfaces/local-answer.js";
import { policyFor } from "../../src/interfaces/policy.js";
import { createGolemPipeline } from "../../src/pipeline/index.js";
import { rawRequest, startProxy, startUpstream } from "./helpers/test-servers.js";

/** A stub service that always confidently answers with a fixed, labeled text. */
function alwaysAnswers(text: string): LocalAnswerService {
  return {
    tryAnswer(_query: LocalAnswerQuery): Promise<LocalAnswerResult> {
      return Promise.resolve({
        answered: true,
        text,
        sources: [{ sourcePath: "docs/wiki/deploy.md", score: 0.9 }],
      });
    },
  };
}

function pipelineWithLocalAnswer(service: LocalAnswerService) {
  return createGolemPipeline({
    compression: NativeLosslessCompression.forProjectDir("/nonexistent-ccr"),
    policy: () => policyFor(1),
    projectId: "proj",
    localAnswer: { service },
  });
}

describe("local-answer sub-mode through the proxy (R2.3)", () => {
  it("serves a confident answer directly — the upstream never sees the request", async () => {
    const received: { count: number } = { count: 0 };
    const upstream = await startUpstream((_req, res) => {
      received.count += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const answerText =
      "**Golem** Answered locally from the project knowledge base — verify independently.\n\nRun npm run build, then golem-run init.";
    const proxy = await startProxy({
      upstreamBaseUrl: upstream.origin,
      pipeline: pipelineWithLocalAnswer(alwaysAnswers(answerText)),
    });
    try {
      const body = JSON.stringify({
        model: "claude-x",
        messages: [{ role: "user", content: "how do I deploy this?" }],
      });
      const res = await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

      expect(received.count).toBe(0);
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.toString("utf8"));
      expect(payload.type).toBe("message");
      expect(payload.role).toBe("assistant");
      expect(payload.model).not.toMatch(/claude/i);
      expect(payload.content).toEqual([{ type: "text", text: answerText }]);
      expect(payload.stop_reason).toBe("end_turn");
      expect(payload.usage.output_tokens).toBeGreaterThan(0);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("serves a valid SSE event sequence when the request asked to stream", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const proxy = await startProxy({
      upstreamBaseUrl: upstream.origin,
      pipeline: pipelineWithLocalAnswer(alwaysAnswers("the answer")),
    });
    try {
      const body = JSON.stringify({
        model: "claude-x",
        stream: true,
        messages: [{ role: "user", content: "how do I deploy this?" }],
      });
      const res = await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

      expect(res.headers["content-type"]).toBe("text/event-stream");
      const text = res.body.toString("utf8");
      const eventNames = [...text.matchAll(/event: (\w+)\n/g)].map((m) => m[1]);
      expect(eventNames).toEqual([
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ]);
      expect(text).toContain("the answer");
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("falls through to the real upstream for an ineligible (multi-turn) request", async () => {
    const received: { body: string } = { body: "" };
    const upstream = await startUpstream((_req, res, reqBody) => {
      received.body = reqBody.toString("utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const proxy = await startProxy({
      upstreamBaseUrl: upstream.origin,
      pipeline: pipelineWithLocalAnswer(alwaysAnswers("would-have-answered")),
    });
    try {
      const body = JSON.stringify({
        model: "claude-x",
        messages: [
          { role: "user", content: "how do I deploy this?" },
          { role: "assistant", content: "which environment?" },
          { role: "user", content: "production" },
        ],
      });
      const res = await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

      expect(res.status).toBe(200);
      expect(received.body).toBe(body); // reached the upstream, byte-faithful
      expect(JSON.parse(res.body.toString("utf8"))).toEqual({ ok: true });
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});
