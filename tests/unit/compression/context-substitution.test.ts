/**
 * R2.2 (spec Decision 24 sub-mode 1, verification-notes §62) —
 * `substituteKnownContent`: proxy-side context substitution against a
 * webcache-derived content-hash lookup.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CcrStore,
  contextSubstitutionMarker,
  DEFAULT_MIN_SUBSTITUTION_CHARS,
  substituteKnownContent,
} from "../../../src/compression/index.js";
import type { BlobStore } from "../../../src/interfaces/storage.js";
import { BlobNotFoundError } from "../../../src/interfaces/storage.js";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** In-memory BlobStore fake — no filesystem needed for these pure tests. */
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

function newStore(): CcrStore {
  return new CcrStore(newInMemoryBlobStore());
}

/** A single lookup fixture: recognizes exactly `content`, labeled `label`. */
function lookupFor(content: string, label = "https://example.com/page") {
  const hash = sha256(content);
  return (h: string) => (h === hash ? label : undefined);
}

const big = (marker: string) => marker.repeat(Math.ceil(600 / marker.length));

describe("substituteKnownContent", () => {
  it("substitutes recognized user text content above minChars", async () => {
    const content = big("known-page-content ");
    const messages = [{ role: "user", content }];
    const ccr = newStore();

    const result = await substituteKnownContent(messages, lookupFor(content), ccr);

    expect(result.substitutions).toBe(1);
    const [out] = result.messages;
    expect(out?.content).not.toBe(content);
    expect(typeof out?.content).toBe("string");
    expect(out?.content as string).toContain("Retrieve original: hash=");
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });

  it("does not substitute content shorter than minChars", async () => {
    const content = "short content";
    expect(content.length).toBeLessThan(DEFAULT_MIN_SUBSTITUTION_CHARS);
    const messages = [{ role: "user", content }];
    const ccr = newStore();

    const result = await substituteKnownContent(messages, lookupFor(content), ccr);

    expect(result.substitutions).toBe(0);
    expect(result.messages[0]?.content).toBe(content);
  });

  it("does not substitute content the lookup doesn't recognize", async () => {
    const content = big("unrecognized ");
    const messages = [{ role: "user", content }];
    const ccr = newStore();

    const result = await substituteKnownContent(messages, () => undefined, ccr);

    expect(result.substitutions).toBe(0);
    expect(result.messages[0]?.content).toBe(content);
  });

  it("leaves assistant messages byte-faithful even if their text matches the lookup", async () => {
    const content = big("assistant-said-this ");
    const messages = [{ role: "assistant", content }];
    const ccr = newStore();

    const result = await substituteKnownContent(messages, lookupFor(content), ccr);

    expect(result.substitutions).toBe(0);
    expect(result.messages[0]?.content).toBe(content);
  });

  it("substitutes inside a user tool_result string content block", async () => {
    const content = big("tool result payload ");
    const messages = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content }],
      },
    ];
    const ccr = newStore();

    const result = await substituteKnownContent(messages, lookupFor(content), ccr);

    expect(result.substitutions).toBe(1);
    const block = (result.messages[0]?.content as Array<Record<string, unknown>>)[0];
    expect(block?.content).not.toBe(content);
    expect(block?.tool_use_id).toBe("t1");
  });

  it("substitutes inside a user tool_result array-of-text-blocks content", async () => {
    const content = big("nested text block ");
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t2",
            content: [{ type: "text", text: content }],
          },
        ],
      },
    ];
    const ccr = newStore();

    const result = await substituteKnownContent(messages, lookupFor(content), ccr);

    expect(result.substitutions).toBe(1);
    const outer = (result.messages[0]?.content as Array<Record<string, unknown>>)[0];
    const inner = (outer?.content as Array<Record<string, unknown>>)[0];
    expect(inner?.text).not.toBe(content);
    expect(inner?.type).toBe("text");
  });

  it("substitutes inside a user array content text block", async () => {
    const content = big("array text block ");
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: content }],
      },
    ];
    const ccr = newStore();

    const result = await substituteKnownContent(messages, lookupFor(content), ccr);

    expect(result.substitutions).toBe(1);
    const block = (result.messages[0]?.content as Array<Record<string, unknown>>)[0];
    expect(block?.text).not.toBe(content);
  });

  it("persists the original into the CCR store, retrievable by the marker's hash", async () => {
    const content = big("persisted original ");
    const messages = [{ role: "user", content }];
    const ccr = newStore();

    const result = await substituteKnownContent(messages, lookupFor(content), ccr);
    expect(result.substitutions).toBe(1);

    const hash = sha256(content);
    const envelope = await ccr.getEnvelope(hash);
    expect(envelope.content).toBe(content);
  });

  it("is fail-open: a CCR persistence failure never blocks substitution or throws", async () => {
    const content = big("failing store content ");
    const messages = [{ role: "user", content }];
    const failingBlobs: BlobStore = {
      exists: async () => false,
      get: async () => {
        throw new Error("unreachable");
      },
      put: async () => {
        throw new Error("disk full");
      },
      delete: async () => {},
      // biome-ignore lint/correctness/useYield: unreachable in this test
      stream: async function* () {
        throw new Error("unreachable");
      },
    } satisfies BlobStore;
    const failingCcr = new CcrStore(failingBlobs);

    const result = await substituteKnownContent(messages, lookupFor(content), failingCcr);
    expect(result.substitutions).toBe(1);
    expect(result.messages[0]?.content).not.toBe(content);
  });

  it("skips substitution when the marker would not be shorter than the original", async () => {
    // A pathological lookup returning a huge label defeats the length guard.
    const content = "x".repeat(DEFAULT_MIN_SUBSTITUTION_CHARS);
    const hugeLabel = "y".repeat(content.length * 2);
    const messages = [{ role: "user", content }];
    const ccr = newStore();

    const result = await substituteKnownContent(messages, lookupFor(content, hugeLabel), ccr);

    expect(result.substitutions).toBe(0);
    expect(result.messages[0]?.content).toBe(content);
  });

  it("multiple messages: only the recognized one substitutes, others pass through unchanged", async () => {
    const known = big("known content ");
    const unknown = big("unknown content ");
    const messages = [
      { role: "user", content: known },
      { role: "user", content: unknown },
      { role: "assistant", content: "reply" },
    ];
    const ccr = newStore();

    const result = await substituteKnownContent(messages, lookupFor(known), ccr);

    expect(result.substitutions).toBe(1);
    expect(result.messages[0]?.content).not.toBe(known);
    expect(result.messages[1]?.content).toBe(unknown);
    expect(result.messages[2]?.content).toBe("reply");
  });
});

describe("contextSubstitutionMarker", () => {
  it("is a pure function of its inputs", () => {
    const a = contextSubstitutionMarker("abc123", "https://example.com", 42);
    const b = contextSubstitutionMarker("abc123", "https://example.com", 42);
    expect(a).toBe(b);
  });

  it("embeds the refId, label, and token count", () => {
    const marker = contextSubstitutionMarker("deadbeef", "https://example.com/x", 100);
    expect(marker).toContain("hash=deadbeef");
    expect(marker).toContain("https://example.com/x");
    expect(marker).toContain("100 tokens");
  });
});
