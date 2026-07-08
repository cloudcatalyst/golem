/**
 * A2 implementation-specific unit tests for LocalDirBlobStore's key validation.
 *
 * The shared BlobStore contract (tests/contract/storage-contract.ts) only
 * exercises well-formed keys across any backend. The KEY_RE guard in
 * #pathFor() is a path-traversal defense specific to the local-directory
 * implementation (S3-compatible backends may have different key rules), so
 * its rejection behavior is covered here rather than in the shared contract.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalDirBlobStore } from "../../../src/compression/index.js";

let root: string;
let store: LocalDirBlobStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "golem-a2-blob-key-"));
  store = new LocalDirBlobStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const INVALID_KEYS: ReadonlyArray<[label: string, key: string]> = [
  ["empty string", ""],
  ["path traversal", "../../etc/passwd"],
  ["forward slash", "a/b"],
  ["backslash", "a\\b"],
  ["leading dot", ".hidden"],
];

describe("LocalDirBlobStore key validation", () => {
  for (const [label, key] of INVALID_KEYS) {
    it(`put() rejects a key with ${label}`, async () => {
      await expect(store.put(key, new Uint8Array([1]))).rejects.toThrow(/invalid blob key/);
    });

    it(`get() rejects a key with ${label}`, async () => {
      await expect(store.get(key)).rejects.toThrow(/invalid blob key/);
    });

    it(`delete() rejects a key with ${label}`, async () => {
      await expect(store.delete(key)).rejects.toThrow(/invalid blob key/);
    });
  }

  it("accepts a well-formed 64-char hex sha256-style key and round-trips it", async () => {
    const key = `${"a".repeat(32)}1234567890abcdef1234567890abcdef`;
    expect(key).toHaveLength(64);
    const payload = new Uint8Array([1, 2, 3, 4, 5]);

    await store.put(key, payload);
    expect(await store.get(key)).toStrictEqual(payload);
    expect(await store.exists(key)).toBe(true);

    await store.delete(key);
    expect(await store.exists(key)).toBe(false);
  });
});
