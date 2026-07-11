/**
 * R2.4 (verification-notes §38) — backfillHeadroomCcrRefs reconciles
 * Headroom's `hash=<hex>` elision markers with Golem's own CCR store so
 * `expand` can recover what the semantic stage elided.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { backfillHeadroomCcrRefs, CcrStore } from "../../../src/compression/index.js";
import type { BlobStore } from "../../../src/interfaces/storage.js";
import { BlobNotFoundError } from "../../../src/interfaces/storage.js";

function sha256(content: string, len = 24): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, len);
}

function md5(content: string, len = 24): string {
  return createHash("md5").update(content, "utf8").digest("hex").slice(0, len);
}

/** In-memory BlobStore fake — no filesystem needed for these pure diff/hash tests. */
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

describe("backfillHeadroomCcrRefs", () => {
  it("backfills an Anthropic-format tool_result marker keyed by a SHA-256[:24] hash (read_lifecycle default)", async () => {
    const original = "line 1\nline 2\nline 3 — the actual file content Headroom elided";
    const hash = sha256(original);
    const before = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: original }],
      },
    ];
    const after = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: `[Read content stale: x.ts was modified after this read — re-read the file for current content. Retrieve original: hash=${hash}]`,
          },
        ],
      },
    ];

    const ccr = newStore();
    const stored = await backfillHeadroomCcrRefs(ccr, before, after);
    expect(stored).toBe(1);

    const envelope = await ccr.getEnvelope(hash);
    expect(envelope.content).toBe(original);
  });

  it("backfills a marker keyed by an MD5[:24] hash (log_compressor's own hash function)", async () => {
    const original = "2026-07-11T00:00:00Z INFO started\n2026-07-11T00:00:01Z INFO ready";
    const hash = md5(original);
    const before = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: original }] },
    ];
    const after = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t2",
            content: `[log compressed. Retrieve original: hash=${hash}]`,
          },
        ],
      },
    ];

    const ccr = newStore();
    const stored = await backfillHeadroomCcrRefs(ccr, before, after);
    expect(stored).toBe(1);
    expect((await ccr.getEnvelope(hash)).content).toBe(original);
  });

  it("backfills a marker keyed by a shorter SHA-256[:12] hash (SmartCrusher's Rust path)", async () => {
    const original = JSON.stringify({ rows: Array.from({ length: 50 }, (_, i) => ({ id: i })) });
    const hash = sha256(original, 12);
    const before = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: original }] },
    ];
    const after = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t3",
            content: `[rows crushed. Retrieve original: hash=${hash}]`,
          },
        ],
      },
    ];

    const ccr = newStore();
    const stored = await backfillHeadroomCcrRefs(ccr, before, after);
    expect(stored).toBe(1);
    expect((await ccr.getEnvelope(hash)).content).toBe(original);
  });

  it("backfills OpenAI-format role:tool messages (bare string content)", async () => {
    const original = "the tool's raw string output";
    const hash = sha256(original);
    const before = [{ role: "tool", tool_call_id: "c1", content: original }];
    const after = [
      { role: "tool", tool_call_id: "c1", content: `[stale. Retrieve original: hash=${hash}]` },
    ];

    const ccr = newStore();
    const stored = await backfillHeadroomCcrRefs(ccr, before, after);
    expect(stored).toBe(1);
    expect((await ccr.getEnvelope(hash)).content).toBe(original);
  });

  it("does NOT backfill a hash that is not actually derived from the replaced content", async () => {
    const before = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t4", content: "real content" }],
      },
    ];
    const after = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t4",
            content: "[elided. Retrieve original: hash=0000000000000000000000]",
          },
        ],
      },
    ];

    const ccr = newStore();
    const stored = await backfillHeadroomCcrRefs(ccr, before, after);
    expect(stored).toBe(0);
  });

  it("leaves unchanged messages and non-tool_result blocks alone", async () => {
    const before = [
      { role: "user", content: "plain turn, untouched" },
      { role: "assistant", content: "reply, untouched" },
    ];
    const after = before; // semantic compressor made no changes

    const ccr = newStore();
    const stored = await backfillHeadroomCcrRefs(ccr, before, after);
    expect(stored).toBe(0);
  });

  it("is idempotent: re-running over the same before/after does not double-count", async () => {
    const original = "content elided twice across two requests";
    const hash = sha256(original);
    const before = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t5", content: original }] },
    ];
    const after = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t5", content: `Retrieve original: hash=${hash}` },
        ],
      },
    ];

    const ccr = newStore();
    const first = await backfillHeadroomCcrRefs(ccr, before, after);
    const second = await backfillHeadroomCcrRefs(ccr, before, after);
    expect(first).toBe(1);
    expect(second).toBe(0); // content-addressed — already present
    expect((await ccr.getEnvelope(hash)).content).toBe(original);
  });

  it("a store failure is swallowed (fail-open) rather than thrown", async () => {
    const original = "content whose store write will fail";
    const hash = sha256(original);
    const before = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t6", content: original }] },
    ];
    const after = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t6", content: `Retrieve original: hash=${hash}` },
        ],
      },
    ];

    // A store whose blob backend always throws on write.
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

    await expect(backfillHeadroomCcrRefs(failingCcr, before, after)).resolves.toBe(0);
  });
});
