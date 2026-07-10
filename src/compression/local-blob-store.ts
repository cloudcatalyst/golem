/**
 * LocalDirBlobStore — default local-directory implementation of the frozen
 * BlobStore contract (src/interfaces/storage.ts), backing the CCR store.
 *
 * Layout: `<root>/<shard>/<key>` with a git-style 2-char shard so a busy CCR
 * store never puts tens of thousands of files in one directory. All paths go
 * through node:path (cross-platform hard rule). Writes are
 * write-temp-then-rename with a Windows-safe fallback (Windows may refuse to
 * rename over an existing file).
 *
 * S3-compatible backends are a drop-in swap behind the same interface
 * (spec Decision 12) — nothing in the CCR layer knows about directories.
 */

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BlobStore } from "../interfaces/storage.js";
import { BlobNotFoundError } from "../interfaces/storage.js";

/** Keys are caller-chosen content hashes; forbid anything path-ambiguous. */
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isErrnoWithCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === code;
}

export class LocalDirBlobStore implements BlobStore {
  readonly #root: string;

  constructor(rootDir: string) {
    this.#root = rootDir;
  }

  #pathFor(key: string): string {
    if (!KEY_RE.test(key)) {
      throw new Error(`invalid blob key: ${JSON.stringify(key)}`);
    }
    const shard = key.length >= 4 ? key.slice(0, 2) : "_";
    return join(this.#root, shard, key);
  }

  async put(
    key: string,
    data: Uint8Array,
    _opts?: { readonly contentType?: string },
  ): Promise<void> {
    // contentType is not persisted here; the CCR envelope carries its own.
    const target = this.#pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(tmp, data);
    try {
      await rename(tmp, target);
    } catch (err) {
      // Windows can refuse to rename over an existing file (EPERM/EEXIST).
      try {
        await rm(target, { force: true });
        await rename(tmp, target);
      } catch {
        await rm(tmp, { force: true });
        throw err;
      }
    }
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      const buf = await readFile(this.#pathFor(key));
      // Copy into a plain Uint8Array (callers must not see Buffer pooling).
      return new Uint8Array(buf);
    } catch (err) {
      if (isErrnoWithCode(err, "ENOENT")) {
        throw new BlobNotFoundError(key);
      }
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.#pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.#pathFor(key), { force: true });
  }

  async *stream(key: string): AsyncIterable<Uint8Array> {
    // No exists() pre-check (it would be a TOCTOU race) — a missing file
    // surfaces as ENOENT from the stream itself and is mapped to the
    // contract's BlobNotFoundError.
    const rs = createReadStream(this.#pathFor(key));
    try {
      for await (const chunk of rs as AsyncIterable<Buffer>) {
        yield new Uint8Array(chunk);
      }
    } catch (err) {
      if (isErrnoWithCode(err, "ENOENT")) {
        throw new BlobNotFoundError(key);
      }
      throw err;
    } finally {
      rs.destroy();
    }
  }
}
