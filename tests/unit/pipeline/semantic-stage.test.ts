/**
 * Pipeline stage 3 — the optional semantic compressor (slider ≥3). Driven
 * directly through pipeline.process() with a fake SemanticCompressor, asserting:
 * it runs only at ≥3, its messages/savings are applied, and it fails open.
 */

import { describe, expect, it, vi } from "vitest";
import { NativeLosslessCompression } from "../../../src/compression/index.js";
import { LocalDirBlobStore } from "../../../src/compression/local-blob-store.js";
import type { SemanticCompressor, SemanticMode } from "../../../src/compression/semantic.js";
import { type SliderLevel, sliderPolicyForLevel } from "../../../src/interfaces/policy.js";
import { createGolemPipeline, type PipelineEvent } from "../../../src/pipeline/index.js";
import type { ProxyRequest } from "../../../src/proxy/types.js";

function messagesRequest(messages: unknown): ProxyRequest {
  return {
    method: "POST",
    url: "/v1/messages",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ model: "claude-x", messages }), "utf8"),
  };
}

function bodyOf(req: ProxyRequest): { messages: Array<{ role: string; content: unknown }> } {
  return JSON.parse((req.body as Buffer).toString("utf8"));
}

/** A pipeline over an in-memory CCR store + an injected semantic compressor. */
function makePipeline(
  level: SliderLevel,
  semantic: SemanticCompressor | undefined,
  onEvent?: (e: PipelineEvent) => void,
) {
  const compression = new NativeLosslessCompression(new LocalDirBlobStore("/nonexistent-ccr"));
  return createGolemPipeline({
    compression,
    policy: () => sliderPolicyForLevel(level),
    projectId: "proj",
    ...(semantic !== undefined ? { semantic } : {}),
    ...(onEvent !== undefined ? { onEvent } : {}),
  });
}

const SAMPLE = [
  { role: "user", content: "first turn" },
  { role: "assistant", content: "reply" },
  { role: "user", content: "second turn" },
];

describe("pipeline semantic stage (slider ≥2)", () => {
  it("invokes the semantic compressor at level 3 and applies its messages + savings", async () => {
    const compress = vi.fn(
      async (msgs: ReadonlyArray<Readonly<Record<string, unknown>>>, _mode: SemanticMode) => ({
        messages: msgs.slice(1), // drop the first (simulate stale elision)
        tokensBefore: 500,
        tokensAfter: 400,
        transformsApplied: ["read_lifecycle:stale:/x"],
      }),
    );
    const events: PipelineEvent[] = [];
    const pipe = makePipeline(3, { compress }, (e) => events.push(e));

    const out = await pipe.process(messagesRequest(SAMPLE));

    expect(compress).toHaveBeenCalledTimes(1);
    expect(compress.mock.calls[0]?.[1]).toBe("aggressive"); // level-3 (aggressive) mode
    expect(bodyOf(out).messages).toHaveLength(SAMPLE.length - 1);
    expect(events[0]?.stageSavings.semantic).toStrictEqual({ tokensBefore: 500, tokensAfter: 400 });
  });

  it("does NOT invoke the semantic compressor at level 1 (semanticCompression off)", async () => {
    const compress = vi.fn();
    const pipe = makePipeline(1, { compress });
    await pipe.process(messagesRequest(SAMPLE));
    expect(compress).not.toHaveBeenCalled();
  });

  it("invokes the semantic compressor at level 2 (balanced) with stale_turns mode", async () => {
    const compress = vi.fn(
      async (_msgs: ReadonlyArray<Readonly<Record<string, unknown>>>, _mode: SemanticMode) => null,
    );
    const pipe = makePipeline(2, { compress });
    await pipe.process(messagesRequest(SAMPLE));
    expect(compress).toHaveBeenCalledTimes(1);
    expect(compress.mock.calls[0]?.[1]).toBe("stale_turns");
  });

  it("fails open: a null result leaves the losslessly-compressed messages intact", async () => {
    const compress = vi.fn(async () => null);
    const pipe = makePipeline(3, { compress });
    const out = await pipe.process(messagesRequest(SAMPLE));
    // Body still parses and keeps all messages (semantic was a no-op).
    expect(bodyOf(out).messages).toHaveLength(SAMPLE.length);
    expect(compress).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when no semantic compressor is injected, even at level 3", async () => {
    const pipe = makePipeline(3, undefined);
    const out = await pipe.process(messagesRequest(SAMPLE));
    expect(bodyOf(out).messages).toHaveLength(SAMPLE.length);
  });
});
