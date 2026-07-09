/**
 * Decision 25 (spec v1.8) recorded-shape integration coverage: the
 * local-drafter intercept running end-to-end through the real GolemProxy —
 * Mode A "draft" injection (level 4), Mode B "local_first" serving/escalation
 * (level 5, opt-in), and confirmation that levels <= 3 are entirely untouched
 * (no InferenceService call at all).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NativeLosslessCompression } from "../../src/compression/index.js";
import type { ChatResult, InferenceService, Role, Vector } from "../../src/interfaces/index.js";
import { HardwareTier, sliderPolicyForLevel } from "../../src/interfaces/index.js";
import { createGolemPipeline } from "../../src/pipeline/index.js";
import { rawRequest, startProxy, startUpstream } from "./helpers/test-servers.js";

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-local-intercept-"));
});
afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

class FakeInferenceService implements InferenceService {
  callCount = 0;

  constructor(private readonly impl: (role: Role) => Promise<ChatResult>) {}

  async chat(role: Role): Promise<ChatResult> {
    this.callCount += 1;
    return this.impl(role);
  }

  async embed(): Promise<Vector[]> {
    throw new Error("not used by these tests");
  }

  capabilities(): HardwareTier {
    return HardwareTier.PMid;
  }
}

function draft(text: string): ChatResult {
  return {
    text,
    model: "qwen2.5-coder:7b",
    role: "drafter",
    promptTokens: 10,
    completionTokens: 5,
    finishReason: "stop",
  };
}

/** Fake upstream that records the last request body and returns 200 JSON. */
function recordingUpstream() {
  const received: { body: string; called: boolean } = { body: "", called: false };
  return {
    received,
    handler: (_req: unknown, res: import("node:http").ServerResponse, body: Buffer): void => {
      received.called = true;
      received.body = body.toString("utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  };
}

const REQUEST_BODY = JSON.stringify({
  model: "claude-x",
  messages: [{ role: "user", content: "what does Array.prototype.map do?" }],
});

describe("local-drafter intercept through the proxy", () => {
  it("level <= 3: never calls the InferenceService (drafts/local-first are level-gated off)", async () => {
    const up = recordingUpstream();
    const upstream = await startUpstream(up.handler);
    const inference = new FakeInferenceService(async () => draft("unused"));
    const pipeline = createGolemPipeline({
      compression: NativeLosslessCompression.forProjectDir(projectDir),
      policy: () => sliderPolicyForLevel(3),
      projectId: projectDir,
      inference,
    });
    const proxy = await startProxy({ upstreamBaseUrl: upstream.origin, pipeline });
    try {
      const res = await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: REQUEST_BODY,
      });
      expect(res.status).toBe(200);
      expect(up.received.called).toBe(true);
      expect(inference.callCount).toBe(0);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("level 4 (Mode A draft): forwards to upstream with a labeled local draft appended to system", async () => {
    const up = recordingUpstream();
    const upstream = await startUpstream(up.handler);
    const inference = new FakeInferenceService(async () =>
      draft("It creates a new array by applying a function to every element."),
    );
    const pipeline = createGolemPipeline({
      compression: NativeLosslessCompression.forProjectDir(projectDir),
      policy: () => sliderPolicyForLevel(4),
      projectId: projectDir,
      inference,
    });
    const proxy = await startProxy({ upstreamBaseUrl: upstream.origin, pipeline });
    try {
      const res = await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: REQUEST_BODY,
      });
      expect(res.status).toBe(200);
      expect(inference.callCount).toBe(1);
      const forwarded = JSON.parse(up.received.body);
      // Claude still receives and answers the request — nothing was skipped.
      expect(forwarded.messages).toStrictEqual(JSON.parse(REQUEST_BODY).messages);
      expect(forwarded.system).toContain("Local draft");
      expect(forwarded.system).toContain("qwen2.5-coder:7b");
      expect(forwarded.system).toContain("new array");
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("level 5 without opt-in: behaves like level 4 (draft only, upstream still called, one inference call)", async () => {
    const up = recordingUpstream();
    const upstream = await startUpstream(up.handler);
    const inference = new FakeInferenceService(async () =>
      draft("a confident, substantive answer"),
    );
    const pipeline = createGolemPipeline({
      compression: NativeLosslessCompression.forProjectDir(projectDir),
      policy: () => sliderPolicyForLevel(5, { localOnlyOptIn: false }),
      projectId: projectDir,
      inference,
    });
    const proxy = await startProxy({ upstreamBaseUrl: upstream.origin, pipeline });
    try {
      const res = await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: REQUEST_BODY,
      });
      expect(res.status).toBe(200);
      expect(up.received.called).toBe(true);
      expect(inference.callCount).toBe(1);
      const forwarded = JSON.parse(up.received.body);
      expect(forwarded.system).toContain("Local draft");
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("level 5 + opt-in (Mode B local-first): serves a synthetic response directly, never calls upstream", async () => {
    const up = recordingUpstream();
    const upstream = await startUpstream(up.handler);
    const inference = new FakeInferenceService(async () =>
      draft("It creates a new array by applying a function to every element."),
    );
    const pipeline = createGolemPipeline({
      compression: NativeLosslessCompression.forProjectDir(projectDir),
      policy: () => sliderPolicyForLevel(5, { localOnlyOptIn: true }),
      projectId: projectDir,
      inference,
    });
    const proxy = await startProxy({ upstreamBaseUrl: upstream.origin, pipeline });
    try {
      const res = await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: REQUEST_BODY,
      });
      expect(res.status).toBe(200);
      expect(up.received.called).toBe(false); // upstream never touched
      expect(inference.callCount).toBe(1); // only one local call, not two
      expect(res.headers["content-type"]).toBe("application/json");
      const parsed = JSON.parse(res.body.toString("utf8"));
      expect(parsed.type).toBe("message");
      expect(parsed.role).toBe("assistant");
      expect(parsed.model).toBe("qwen2.5-coder:7b");
      expect(parsed.stop_reason).toBe("end_turn");
      expect(parsed.content[0].text).toContain("**Golem** Used qwen2.5-coder:7b locally");
      expect(parsed.content[0].text).toContain("new array");
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("level 5 + opt-in, streaming request: serves a valid SSE stream directly", async () => {
    const up = recordingUpstream();
    const upstream = await startUpstream(up.handler);
    const inference = new FakeInferenceService(async () => draft("a straightforward answer"));
    const pipeline = createGolemPipeline({
      compression: NativeLosslessCompression.forProjectDir(projectDir),
      policy: () => sliderPolicyForLevel(5, { localOnlyOptIn: true }),
      projectId: projectDir,
      inference,
    });
    const proxy = await startProxy({ upstreamBaseUrl: upstream.origin, pipeline });
    try {
      const streamingBody = JSON.stringify({ ...JSON.parse(REQUEST_BODY), stream: true });
      const res = await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: streamingBody,
      });
      expect(res.status).toBe(200);
      expect(up.received.called).toBe(false);
      expect(res.headers["content-type"]).toBe("text/event-stream");
      const text = res.body.toString("utf8");
      expect(text).toContain("event: message_start");
      expect(text).toContain("event: content_block_delta");
      expect(text).toContain("event: message_stop");
      expect(text).toContain("a straightforward answer");
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("level 5 + opt-in, refusal-shaped draft: escalates to upstream with the rejected draft injected (single inference call)", async () => {
    const up = recordingUpstream();
    const upstream = await startUpstream(up.handler);
    const inference = new FakeInferenceService(async () =>
      draft("I don't have access to the file you're asking about."),
    );
    const pipeline = createGolemPipeline({
      compression: NativeLosslessCompression.forProjectDir(projectDir),
      policy: () => sliderPolicyForLevel(5, { localOnlyOptIn: true }),
      projectId: projectDir,
      inference,
    });
    const proxy = await startProxy({ upstreamBaseUrl: upstream.origin, pipeline });
    try {
      const res = await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: REQUEST_BODY,
      });
      expect(res.status).toBe(200);
      expect(up.received.called).toBe(true); // escalated to Claude
      expect(inference.callCount).toBe(1); // the rejected draft is reused, not re-queried
      const forwarded = JSON.parse(up.received.body);
      expect(forwarded.system).toContain("Local draft");
      expect(forwarded.system).toContain("I don't have access");
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("level 5 + opt-in, inference endpoint down: escalates to upstream with no draft injected, forwards untouched", async () => {
    const up = recordingUpstream();
    const upstream = await startUpstream(up.handler);
    const inference = new FakeInferenceService(async () => {
      throw new Error("could not reach inference endpoint");
    });
    const pipeline = createGolemPipeline({
      compression: NativeLosslessCompression.forProjectDir(projectDir),
      policy: () => sliderPolicyForLevel(5, { localOnlyOptIn: true }),
      projectId: projectDir,
      inference,
    });
    const proxy = await startProxy({ upstreamBaseUrl: upstream.origin, pipeline });
    try {
      const res = await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: REQUEST_BODY,
      });
      expect(res.status).toBe(200);
      expect(up.received.called).toBe(true);
      const forwarded = JSON.parse(up.received.body);
      expect(forwarded.system).toBeUndefined();
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("without an InferenceService configured, level 5 + opt-in is a no-op (fail-open, forwards untouched)", async () => {
    const up = recordingUpstream();
    const upstream = await startUpstream(up.handler);
    const pipeline = createGolemPipeline({
      compression: NativeLosslessCompression.forProjectDir(projectDir),
      policy: () => sliderPolicyForLevel(5, { localOnlyOptIn: true }),
      projectId: projectDir,
      // no `inference` option supplied
    });
    const proxy = await startProxy({ upstreamBaseUrl: upstream.origin, pipeline });
    try {
      const res = await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: REQUEST_BODY,
      });
      expect(res.status).toBe(200);
      expect(up.received.called).toBe(true);
      expect(up.received.body).toBe(REQUEST_BODY);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});
