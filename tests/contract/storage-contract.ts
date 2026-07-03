/**
 * Reusable contract harness for BlobStore implementations
 * (local dir | S3-compatible).
 */

import { describe, expect, it } from "vitest";
import type { BlobStore } from "../../src/interfaces/storage.js";
import { BlobNotFoundError } from "../../src/interfaces/storage.js";

export function describeBlobStoreContract(
  name: string,
  makeStore: () => BlobStore | Promise<BlobStore>,
): void {
  describe(`BlobStore contract: ${name}`, () => {
    it("put/get round-trips binary data", async () => {
      const store = await makeStore();
      const payload = new Uint8Array(1000).map((_, i) => i % 256);
      await store.put("k1", payload);
      expect(await store.get("k1")).toStrictEqual(payload);
    });

    it("exists reflects state", async () => {
      const store = await makeStore();
      expect(await store.exists("nope")).toBe(false);
      await store.put("k2", new Uint8Array([1]));
      expect(await store.exists("k2")).toBe(true);
    });

    it("get of a missing key rejects with BlobNotFoundError", async () => {
      const store = await makeStore();
      await expect(store.get("missing")).rejects.toBeInstanceOf(BlobNotFoundError);
    });

    it("delete is idempotent", async () => {
      const store = await makeStore();
      await store.put("k3", new Uint8Array([1]));
      await store.delete("k3");
      await store.delete("k3"); // second delete must not throw
      expect(await store.exists("k3")).toBe(false);
    });

    it("stream concatenates to the full blob", async () => {
      const store = await makeStore();
      const payload = new Uint8Array(10_000).map((_, i) => (i * 7) % 256);
      await store.put("k4", payload);
      const chunks: Uint8Array[] = [];
      for await (const chunk of store.stream("k4")) {
        chunks.push(chunk);
      }
      const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      expect(merged).toStrictEqual(payload);
    });
  });
}
