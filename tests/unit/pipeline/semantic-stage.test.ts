/**
 * Pipeline stage 3 — the optional semantic compressor (slider ≥3). Driven
 * directly through pipeline.process() with a fake SemanticCompressor, asserting:
 * it runs only at ≥3, its messages/savings are applied, and it fails open.
 */

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CcrStore, NativeLosslessCompression } from "../../../src/compression/index.js";
import { LocalDirBlobStore } from "../../../src/compression/local-blob-store.js";
import type { SemanticCompressor, SemanticMode } from "../../../src/compression/semantic.js";
import { type SliderLevel, sliderPolicyForLevel } from "../../../src/interfaces/policy.js";
import type { BlobStore } from "../../../src/interfaces/storage.js";
import { BlobNotFoundError } from "../../../src/interfaces/storage.js";
import { createGolemPipeline, type PipelineEvent } from "../../../src/pipeline/index.js";
import type { ProxyRequest } from "../../../src/proxy/types.js";

/** In-memory BlobStore fake — avoids filesystem dependence in this unit test. */
function newInMemoryBlobStore(): BlobStore {
  const blobs = new Map<string, Uint8Array>();
  return {
    async put(key, data) {
      blobs.set(key, data);
    },
    async get(key) {
      const data = blobs.get(key);
      if (data === undefined) throw new BlobNotFoundError(key);
      return data;
    },
    async exists(key) {
      return blobs.has(key);
    },
    async delete(key) {
      blobs.delete(key);
    },
    async *stream(key) {
      const data = blobs.get(key);
      if (data === undefined) throw new BlobNotFoundError(key);
      yield data;
    },
  };
}

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
  opts: {
    upstreamBaseUrl?: string;
    forceSemanticOnCaching?: boolean;
    assumeCachingUpstream?: boolean;
    headroomCcrStore?: CcrStore;
  } = {},
) {
  const compression = new NativeLosslessCompression(new LocalDirBlobStore("/nonexistent-ccr"));
  return createGolemPipeline({
    compression,
    policy: () => sliderPolicyForLevel(level),
    projectId: "proj",
    // A non-caching upstream so the (lossy) semantic stage is allowed to run —
    // it is gated OFF on Anthropic-style caching upstreams (Decision 31).
    upstreamBaseUrl: opts.upstreamBaseUrl ?? "https://openrouter.ai/api/v1",
    ...(opts.forceSemanticOnCaching !== undefined
      ? { forceSemanticOnCaching: opts.forceSemanticOnCaching }
      : {}),
    ...(opts.assumeCachingUpstream !== undefined
      ? { assumeCachingUpstream: opts.assumeCachingUpstream }
      : {}),
    ...(semantic !== undefined ? { semantic } : {}),
    ...(onEvent !== undefined ? { onEvent } : {}),
    ...(opts.headroomCcrStore !== undefined ? { headroomCcrStore: opts.headroomCcrStore } : {}),
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

  describe("Decision-31 caching-upstream gate + R2.6 forceSemanticOnCaching bypass", () => {
    it("does NOT invoke the semantic compressor on an Anthropic-style upstream by default", async () => {
      const compress = vi.fn(async () => null);
      const pipe = makePipeline(3, { compress }, undefined, {
        upstreamBaseUrl: "https://api.anthropic.com",
      });
      await pipe.process(messagesRequest(SAMPLE));
      expect(compress).not.toHaveBeenCalled();
    });

    it("invokes the semantic compressor on an Anthropic-style upstream when forceSemanticOnCaching is true", async () => {
      const compress = vi.fn(async (msgs: ReadonlyArray<Readonly<Record<string, unknown>>>) => ({
        messages: msgs,
        tokensBefore: 100,
        tokensAfter: 90,
        transformsApplied: [],
      }));
      const pipe = makePipeline(3, { compress }, undefined, {
        upstreamBaseUrl: "https://api.anthropic.com",
        forceSemanticOnCaching: true,
      });
      await pipe.process(messagesRequest(SAMPLE));
      expect(compress).toHaveBeenCalledTimes(1);
    });

    it("forceSemanticOnCaching has no effect when the level doesn't enable semantic compression", async () => {
      const compress = vi.fn();
      const pipe = makePipeline(1, { compress }, undefined, {
        upstreamBaseUrl: "https://api.anthropic.com",
        forceSemanticOnCaching: true,
      });
      await pipe.process(messagesRequest(SAMPLE));
      expect(compress).not.toHaveBeenCalled();
    });
  });

  describe("R6.1 case (a) — assumeCachingUpstream override (verification-notes §73)", () => {
    it("does NOT invoke the semantic compressor on a Claude-via-Azure host when assumed caching", async () => {
      // The URL heuristic would treat this non-anthropic.com host as NON-caching
      // and let the lossy stage run — the provider override marks it caching so
      // Claude-via-Azure's prompt cache is not broken (fail-safe).
      const compress = vi.fn(async () => null);
      const pipe = makePipeline(3, { compress }, undefined, {
        upstreamBaseUrl: "https://acme.services.ai.azure.com/anthropic",
        assumeCachingUpstream: true,
      });
      await pipe.process(messagesRequest(SAMPLE));
      expect(compress).not.toHaveBeenCalled();
    });

    it("the override wins over the URL heuristic in both directions (false forces non-caching)", async () => {
      const compress = vi.fn(async (msgs: ReadonlyArray<Readonly<Record<string, unknown>>>) => ({
        messages: msgs,
        tokensBefore: 100,
        tokensAfter: 90,
        transformsApplied: [],
      }));
      // anthropic.com would normally be caching (semantic off); forcing false runs it.
      const pipe = makePipeline(3, { compress }, undefined, {
        upstreamBaseUrl: "https://api.anthropic.com",
        assumeCachingUpstream: false,
      });
      await pipe.process(messagesRequest(SAMPLE));
      expect(compress).toHaveBeenCalledTimes(1);
    });
  });

  describe("R2.4 — headroomCcrStore backfill (verification-notes §38)", () => {
    it("backfills a Headroom read_lifecycle marker so expand's own retrieve() recovers it", async () => {
      const staleFileContent = "export function old() { return 1; }\n// stale version of this file";
      const hash = createHash("sha256").update(staleFileContent, "utf8").digest("hex").slice(0, 24);
      const messages = [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: staleFileContent }],
        },
      ];
      const elided = [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: `[Read content stale: x.ts was modified after this read — re-read the file for current content. Retrieve original: hash=${hash}]`,
            },
          ],
        },
      ];
      const compress = vi.fn(async () => ({
        messages: elided,
        tokensBefore: 200,
        tokensAfter: 40,
        transformsApplied: ["read_lifecycle:stale:x.ts"],
      }));

      const ccr = new CcrStore(newInMemoryBlobStore());
      const events: PipelineEvent[] = [];
      const pipe = makePipeline(3, { compress }, (e) => events.push(e), { headroomCcrStore: ccr });

      const out = await pipe.process(messagesRequest(messages));

      // The marker in the forwarded body is unchanged — no marker-text rewriting.
      const outMessages = bodyOf(out).messages as Array<{ content: Array<{ content: string }> }>;
      expect(outMessages[0]?.content[0]?.content).toContain(`hash=${hash}`);

      // Golem's own CCR store — the exact code path `expand` uses — now
      // resolves that hash to the pre-elision content.
      const envelope = await ccr.getEnvelope(hash);
      expect(envelope.content).toBe(staleFileContent);
      expect(events[0]?.ccrRefsStored).toBe(1);
    });

    it("does not backfill anything when no headroomCcrStore is configured (today's gap, unchanged)", async () => {
      const staleFileContent = "some file content that gets elided";
      const hash = createHash("sha256").update(staleFileContent, "utf8").digest("hex").slice(0, 24);
      const messages = [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_2", content: staleFileContent }],
        },
      ];
      const elided = [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_2",
              content: `Retrieve original: hash=${hash}`,
            },
          ],
        },
      ];
      const compress = vi.fn(async () => ({
        messages: elided,
        tokensBefore: 100,
        tokensAfter: 20,
        transformsApplied: ["read_lifecycle:stale:y.ts"],
      }));

      const events: PipelineEvent[] = [];
      const pipe = makePipeline(3, { compress }, (e) => events.push(e));
      await pipe.process(messagesRequest(messages));

      expect(events[0]?.ccrRefsStored).toBe(0);
    });
  });
});
