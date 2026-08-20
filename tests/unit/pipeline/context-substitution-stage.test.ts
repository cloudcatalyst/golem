/**
 * Pipeline stage 4 — proxy-side context substitution (R2.2, spec Decision 24
 * sub-mode 1, verification-notes §62). Driven directly through
 * pipeline.process() with a real CcrStore and an injected lookup, asserting
 * the gate (semanticCompression !== "off", contextSubstitution configured,
 * non-caching upstream) and the emitted stageSavings/avoidedUpstreamInputTokens.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CcrStore, NativeLosslessCompression } from "../../../src/compression/index.js";
import { LocalDirBlobStore } from "../../../src/compression/local-blob-store.js";
import { type SliderLevel, policyFor } from "../../../src/interfaces/policy.js";
import type { BlobStore } from "../../../src/interfaces/storage.js";
import { BlobNotFoundError } from "../../../src/interfaces/storage.js";
import { createGolemPipeline, type PipelineEvent } from "../../../src/pipeline/index.js";
import type { ProxyRequest } from "../../../src/proxy/types.js";

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

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

const big = (marker: string) => marker.repeat(Math.ceil(600 / marker.length));

/** A pipeline over a real CcrStore + an optional injected contextSubstitution lookup. */
function makePipeline(
  level: SliderLevel,
  onEvent: (e: PipelineEvent) => void,
  opts: {
    upstreamBaseUrl?: string;
    contextSubstitutionCcr?: CcrStore;
    lookup?: (hash: string) => string | undefined;
    minChars?: number;
  } = {},
) {
  const compression = new NativeLosslessCompression(new LocalDirBlobStore("/nonexistent-ccr"));
  const ccrStore = opts.contextSubstitutionCcr;
  return createGolemPipeline({
    compression,
    policy: () => policyFor(level),
    projectId: "proj",
    upstreamBaseUrl: opts.upstreamBaseUrl ?? "https://openrouter.ai/api/v1",
    onEvent,
    ...(ccrStore !== undefined
      ? {
          contextSubstitution: {
            ccrStore,
            lookup: () => opts.lookup ?? (() => undefined),
            ...(opts.minChars !== undefined ? { minChars: opts.minChars } : {}),
          },
        }
      : {}),
  });
}

describe("pipeline context-substitution stage (R2.2)", () => {
  it("substitutes recognized content at level 2 on a non-caching upstream", async () => {
    const content = big("known webcache page ");
    const hash = sha256(content);
    const ccr = new CcrStore(newInMemoryBlobStore());
    const events: PipelineEvent[] = [];
    const pipe = makePipeline(2, (e) => events.push(e), {
      contextSubstitutionCcr: ccr,
      lookup: (h) => (h === hash ? "https://example.com/page" : undefined),
    });

    const out = await pipe.process(messagesRequest([{ role: "user", content }]));

    const outMessages = bodyOf(out).messages;
    expect(outMessages[0]?.content).not.toBe(content);
    expect(events[0]?.avoidedUpstreamInputTokens).toBeGreaterThan(0);
    expect(events[0]?.stageSavings.contextSubstitution?.tokensBefore).toBeGreaterThan(
      events[0]?.stageSavings.contextSubstitution?.tokensAfter ?? Number.POSITIVE_INFINITY,
    );
    expect(events[0]?.ccrRefsStored).toBe(1);

    const envelope = await ccr.getEnvelope(hash);
    expect(envelope.content).toBe(content);
  });

  it("does NOT run at level 1 (semanticCompression off)", async () => {
    const content = big("known webcache page ");
    const hash = sha256(content);
    const ccr = new CcrStore(newInMemoryBlobStore());
    const events: PipelineEvent[] = [];
    const pipe = makePipeline(1, (e) => events.push(e), {
      contextSubstitutionCcr: ccr,
      lookup: (h) => (h === hash ? "https://example.com/page" : undefined),
    });

    const out = await pipe.process(messagesRequest([{ role: "user", content }]));

    // Nothing changed at all this request, so the pipeline takes its
    // byte-faithful early-return path and never emits an event (same
    // convention as the semantic stage's own gate tests).
    expect(bodyOf(out).messages[0]?.content).toBe(content);
    expect(events).toHaveLength(0);
  });

  it("does NOT run on a caching (Anthropic-style) upstream, even at level 3", async () => {
    const content = big("known webcache page ");
    const hash = sha256(content);
    const ccr = new CcrStore(newInMemoryBlobStore());
    const events: PipelineEvent[] = [];
    const pipe = makePipeline(3, (e) => events.push(e), {
      upstreamBaseUrl: "https://api.anthropic.com",
      contextSubstitutionCcr: ccr,
      lookup: (h) => (h === hash ? "https://example.com/page" : undefined),
    });

    const out = await pipe.process(messagesRequest([{ role: "user", content }]));

    expect(bodyOf(out).messages[0]?.content).toBe(content);
    expect(events).toHaveLength(0);
  });

  it("is a no-op when no contextSubstitution option is configured, even at level 3", async () => {
    const content = big("known webcache page ");
    const events: PipelineEvent[] = [];
    const pipe = makePipeline(3, (e) => events.push(e));

    const out = await pipe.process(messagesRequest([{ role: "user", content }]));

    expect(bodyOf(out).messages[0]?.content).toBe(content);
    expect(events).toHaveLength(0);
  });

  it("finds nothing to substitute when the lookup recognizes no hash — request unchanged", async () => {
    const content = big("unrecognized content ");
    const ccr = new CcrStore(newInMemoryBlobStore());
    const events: PipelineEvent[] = [];
    const pipe = makePipeline(3, (e) => events.push(e), {
      contextSubstitutionCcr: ccr,
      lookup: () => undefined,
    });

    const out = await pipe.process(messagesRequest([{ role: "user", content }]));

    expect(bodyOf(out).messages[0]?.content).toBe(content);
    expect(events).toHaveLength(0);
  });

  it("runs independently of whether a Headroom semantic sidecar is configured (no `semantic` option here)", async () => {
    // makePipeline in this file never passes a `semantic` compressor at all —
    // this test simply documents/asserts that omission doesn't block stage 4.
    const content = big("known webcache page ");
    const hash = sha256(content);
    const ccr = new CcrStore(newInMemoryBlobStore());
    const events: PipelineEvent[] = [];
    const pipe = makePipeline(3, (e) => events.push(e), {
      contextSubstitutionCcr: ccr,
      lookup: (h) => (h === hash ? "https://example.com/page" : undefined),
    });

    await pipe.process(messagesRequest([{ role: "user", content }]));

    expect(events[0]?.avoidedUpstreamInputTokens).toBeGreaterThan(0);
  });
});
