/**
 * Decision 52 — pipeline stage 5 (brevity) driven through pipeline.process().
 *
 * Complements brevity.test.ts (which unit-tests the transform): here the
 * assertions are about the STAGE's contract inside the real pipeline — that it
 * is off by default, that it leaves the request byte-identical when off, that it
 * only ever changes `system`, and that it reports its own cost.
 */

import { describe, expect, it } from "vitest";
import { NativeLosslessCompression } from "../../../src/compression/index.js";
import { LocalDirBlobStore } from "../../../src/compression/local-blob-store.js";
import {
  type BrevityDial,
  type SliderLevel,
  policyFor,
} from "../../../src/interfaces/policy.js";
import { createGolemPipeline, type PipelineEvent } from "../../../src/pipeline/index.js";
import type { ProxyRequest } from "../../../src/proxy/types.js";

function makePipeline(
  level: SliderLevel,
  brevity: BrevityDial,
  onEvent?: (e: PipelineEvent) => void,
) {
  return createGolemPipeline({
    compression: new NativeLosslessCompression(new LocalDirBlobStore("/nonexistent-ccr")),
    policy: () => policyFor(level, { brevity }),
    projectId: "proj",
    ...(onEvent !== undefined ? { onEvent } : {}),
  });
}

function request(body: unknown): ProxyRequest {
  return {
    method: "POST",
    url: "/v1/messages",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body), "utf8"),
  };
}

function bodyOf(req: ProxyRequest): Record<string, unknown> {
  return JSON.parse((req.body as Buffer).toString("utf8"));
}

const SAMPLE = {
  model: "claude-opus-5",
  system: "You are a helpful assistant.",
  messages: [{ role: "user", content: "hello" }],
};

describe("pipeline brevity stage (Decision 52)", () => {
  it("does nothing at slider 1 with the dial on auto — brevity is never implied at <=1", async () => {
    const out = await makePipeline(1, "auto").process(request(SAMPLE));
    expect(JSON.stringify(bodyOf(out).system)).not.toContain("golem-brevity");
  });

  it("leaves the request byte-IDENTICAL when the dial is off", async () => {
    const req = request(SAMPLE);
    const out = await makePipeline(2, "off").process(req);
    // Same object reference: the pipeline's "no stage changed anything" path.
    expect(out).toBe(req);
  });

  it("is a full bypass at slider 0 even with brevity pinned to ultra", async () => {
    const req = request(SAMPLE);
    const out = await makePipeline(0, "ultra").process(req);
    expect(out).toBe(req);
  });

  it("injects at slider 2 when the dial is on auto (preset: lite)", async () => {
    const out = await makePipeline(2, "auto").process(request(SAMPLE));
    const system = bodyOf(out).system as string;
    expect(system).toContain('level="lite"');
    expect(system.startsWith("You are a helpful assistant.")).toBe(true);
  });

  it("honours an explicit pin over the preset", async () => {
    const out = await makePipeline(2, "ultra").process(request(SAMPLE));
    expect(bodyOf(out).system as string).toContain('level="ultra"');
  });

  it("changes ONLY system — messages survive byte-identically", async () => {
    const original = {
      model: "claude-opus-5",
      system: "S",
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "t", input: { a: 1 } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "r" }] },
      ],
    };
    const out = await makePipeline(3, "full").process(request(original));
    const body = bodyOf(out);
    expect(JSON.stringify(body.messages)).toBe(JSON.stringify(original.messages));
    expect(body.model).toBe("claude-opus-5");
    expect(body.system as string).toContain("golem-brevity");
  });

  it("reports the brevity level and its input-token COST on the telemetry event", async () => {
    const events: PipelineEvent[] = [];
    await makePipeline(3, "full", (e) => events.push(e)).process(request(SAMPLE));
    expect(events).toHaveLength(1);
    expect(events[0]?.brevity).toBe("full");
    // Never report a saving without its cost (verification-notes §87).
    expect(events[0]?.brevityDirectiveTokens).toBeGreaterThan(0);
  });

  it("records brevity 'off' on the event when the dial is off", async () => {
    const events: PipelineEvent[] = [];
    // Level 3 so a compression stage still fires and an event is emitted.
    await makePipeline(3, "off", (e) => events.push(e)).process(
      request({ ...SAMPLE, messages: [{ role: "user", content: "x".repeat(4000) }] }),
    );
    for (const event of events) {
      expect(event.brevity).toBe("off");
      expect(event.brevityDirectiveTokens).toBe(0);
    }
  });

  it("is byte-stable turn over turn — the prompt-cache prefix must not flap", async () => {
    const pipeline = makePipeline(2, "full");
    const first = await pipeline.process(request(SAMPLE));
    const second = await pipeline.process(request(SAMPLE));
    expect((first.body as Buffer).toString("utf8")).toBe((second.body as Buffer).toString("utf8"));
  });

  it("does not rewrite non-messages requests", async () => {
    const req: ProxyRequest = {
      method: "POST",
      url: "/v1/complete",
      headers: {},
      body: Buffer.from(JSON.stringify(SAMPLE), "utf8"),
    };
    expect(await makePipeline(2, "ultra").process(req)).toBe(req);
  });
});
