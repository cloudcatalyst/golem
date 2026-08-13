/**
 * A2 implementation-specific unit tests for LocalDirBlobStore's key validation.
 *
 * The shared BlobStore contract (tests/contract/storage-contract.ts) only
 * exercises well-formed keys across any backend. The KEY_RE guard in
 * #pathFor() is a path-traversal defense specific to the local-directory
 * implementation (S3-compatible backends may have different key rules), so
 * its rejection behavior is covered here rather than in the shared contract.
 */

import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { LocalDirBlobStore } from "../../../src/compression/index.js";
import { BlobNotFoundError } from "../../../src/interfaces/storage.js";
import { useTempDirs } from "../../helpers/tmp.js";

let root: string;
let store: LocalDirBlobStore;

const newTempDir = useTempDirs("golem-a2-blob-key-");

beforeEach(async () => {
  root = await newTempDir();
  store = new LocalDirBlobStore(root);
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

describe("LocalDirBlobStore stream()", () => {
  it("rejects with BlobNotFoundError for a missing key", async () => {
    const drain = async () => {
      for await (const _chunk of store.stream("missing")) {
        // never reached; draining forces the generator body to run.
      }
    };
    await expect(drain()).rejects.toBeInstanceOf(BlobNotFoundError);
  });
});

describe("LocalDirBlobStore put() rename-collision fallback", () => {
  // #pathFor("collidingkey123") shards on the first two chars, so the target
  // path is `<root>/co/collidingkey123`. Pre-creating a *directory* there
  // makes the atomic rename(tmp, target) fail on every OS (POSIX rename(2)
  // and Windows both refuse file-over-directory renames with EISDIR/EPERM),
  // and then makes the fallback's `rm(target, { force: true })` fail too
  // (fs.rm on a directory without `recursive: true` throws ERR_FS_EISDIR).
  // That drives the exact branch where both the rename and the fallback
  // attempt fail, and the ORIGINAL rename error must be what put() rejects
  // with — not the fallback rm's error.
  const key = "collidingkey123";

  it("rejects with the original rename error, not the fallback error, when both fail", async () => {
    const target = join(root, "co", key);
    await mkdir(target, { recursive: true });

    const rejection = await store.put(key, new Uint8Array([1, 2, 3])).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(rejection).toBeDefined();
    // The original error comes from the rename() syscall, not from rm().
    expect((rejection as NodeJS.ErrnoException).syscall).toBe("rename");
  });

  it("leaves no leftover .tmp file and does not disturb the colliding directory", async () => {
    const shardDir = join(root, "co");
    const target = join(shardDir, key);
    await mkdir(target, { recursive: true });

    await expect(store.put(key, new Uint8Array([1, 2, 3]))).rejects.toThrow();

    // The pre-existing directory at the target path must be untouched.
    expect((await stat(target)).isDirectory()).toBe(true);
    // The only entry in the shard directory is that directory — the
    // `<target>.<uuid>.tmp` scratch file must have been cleaned up.
    expect(await readdir(shardDir)).toStrictEqual([key]);
  });
});
