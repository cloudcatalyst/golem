/**
 * R3.1 (spec Decision 34) — rerankHits: chat-judge reorder of search hits via
 * a fake InferenceService (no network, no Ollama). The central contract under
 * test is the fallback behavior: any failure must return the original order
 * unchanged rather than throw, since a rerank problem must never turn an
 * already-successful search into an error.
 */

import { describe, expect, it } from "vitest";
import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  HardwareTier,
  InferenceService,
  Role,
  Vector,
} from "../../../src/interfaces/inference.js";
import { HardwareTier as Tier } from "../../../src/interfaces/inference.js";
import type { Hit } from "../../../src/interfaces/knowledge.js";
import { rerankHits } from "../../../src/knowledge/rerank.js";

class FakeInferenceService implements InferenceService {
  lastRole: Role | undefined;
  lastMessages: readonly ChatMessage[] | undefined;
  lastOpts: ChatOptions | undefined;

  constructor(private readonly respond: (() => string) | string) {}

  async chat(
    role: Role,
    messages: readonly ChatMessage[],
    opts?: ChatOptions,
  ): Promise<ChatResult> {
    this.lastRole = role;
    this.lastMessages = messages;
    this.lastOpts = opts;
    const text = typeof this.respond === "function" ? this.respond() : this.respond;
    return {
      text,
      model: "fake-model",
      role,
      promptTokens: 10,
      completionTokens: 10,
      finishReason: "stop",
    };
  }

  async embed(): Promise<Vector[]> {
    throw new Error("not used by these tests");
  }

  capabilities(): HardwareTier {
    return Tier.PMid;
  }
}

class ThrowingInferenceService implements InferenceService {
  async chat(): Promise<ChatResult> {
    throw new Error("endpoint unreachable");
  }

  async embed(): Promise<Vector[]> {
    throw new Error("not used by these tests");
  }

  capabilities(): HardwareTier {
    return Tier.PMid;
  }
}

function hit(chunkId: string, score: number): Hit {
  return {
    chunk: {
      chunkId,
      projectId: "p1",
      text: `body of ${chunkId}`,
      metadata: {},
    },
    score,
    scope: "knowledge",
  };
}

describe("rerankHits", () => {
  it("short-circuits with 0 hits without calling the model", async () => {
    const fake = new FakeInferenceService("should never be read");
    const result = await rerankHits(fake, "query", []);
    expect(result).toEqual([]);
    expect(fake.lastRole).toBeUndefined();
  });

  it("short-circuits with 1 hit without calling the model", async () => {
    const fake = new FakeInferenceService("should never be read");
    const only = [hit("a", 0.5)];
    const result = await rerankHits(fake, "query", only);
    expect(result).toEqual(only);
    expect(fake.lastRole).toBeUndefined();
  });

  it("reorders hits per the model's chunkId order, calling role judge with a jsonSchema", async () => {
    const hits = [hit("a", 0.9), hit("b", 0.5), hit("c", 0.7)];
    const fake = new FakeInferenceService(JSON.stringify({ order: ["c", "a", "b"] }));
    const result = await rerankHits(fake, "some query", hits);

    expect(fake.lastRole).toBe("judge");
    expect(fake.lastOpts?.jsonSchema).toBeDefined();
    expect(result.map((h) => h.chunk.chunkId)).toEqual(["c", "a", "b"]);
  });

  it("falls back to original order on malformed (non-JSON) model output", async () => {
    const hits = [hit("a", 0.9), hit("b", 0.5)];
    const fake = new FakeInferenceService("not json at all");
    const result = await rerankHits(fake, "q", hits);
    expect(result).toEqual(hits);
  });

  it("falls back to original order when the model drops a chunkId", async () => {
    const hits = [hit("a", 0.9), hit("b", 0.5), hit("c", 0.7)];
    const fake = new FakeInferenceService(JSON.stringify({ order: ["c", "a"] }));
    const result = await rerankHits(fake, "q", hits);
    expect(result).toEqual(hits);
  });

  it("falls back to original order when the model invents an unknown chunkId", async () => {
    const hits = [hit("a", 0.9), hit("b", 0.5)];
    const fake = new FakeInferenceService(JSON.stringify({ order: ["a", "made-up-id"] }));
    const result = await rerankHits(fake, "q", hits);
    expect(result).toEqual(hits);
  });

  it("falls back to original order when the model duplicates a chunkId", async () => {
    const hits = [hit("a", 0.9), hit("b", 0.5)];
    const fake = new FakeInferenceService(JSON.stringify({ order: ["a", "a"] }));
    const result = await rerankHits(fake, "q", hits);
    expect(result).toEqual(hits);
  });

  it("falls back to original order when inference.chat throws", async () => {
    const hits = [hit("a", 0.9), hit("b", 0.5)];
    const result = await rerankHits(new ThrowingInferenceService(), "q", hits);
    expect(result).toEqual(hits);
  });
});
