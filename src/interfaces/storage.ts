/**
 * BlobStore — FROZEN CONTRACT (IMPLEMENTATION_PLAN §2 / spec §2.2 decision 12).
 *
 * Content-addressed blob storage backing the CCR store and artifact storage.
 * Default implementation is a local directory; any S3-compatible endpoint
 * (e.g. MinIO on a NAS) must be a drop-in swap via config URL — LAN offload
 * is configuration, not code (spec §2.2).
 *
 * Promise/AsyncIterable by contract: blob I/O may cross the network.
 */

/** Thrown by get()/stream() for a missing key. */
export class BlobNotFoundError extends Error {
  constructor(key: string) {
    super(`blob not found: ${key}`);
    this.name = "BlobNotFoundError";
  }
}

/** Keyed binary storage. Keys are content hashes chosen by the caller. */
export interface BlobStore {
  put(key: string, data: Uint8Array, opts?: { readonly contentType?: string }): Promise<void>;

  /** Return the blob; reject with BlobNotFoundError if absent. */
  get(key: string): Promise<Uint8Array>;

  exists(key: string): Promise<boolean>;

  /** Remove the blob; missing keys are a no-op. */
  delete(key: string): Promise<void>;

  /** Yield the blob in chunks; reject on first iteration if absent. */
  stream(key: string): AsyncIterable<Uint8Array>;
}
