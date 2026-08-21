/**
 * CCR (Compress-Cache-Retrieve) store — content-addressed persistence of
 * ORIGINALS so `CompressionService.retrieve(ref)` returns the exact bytes
 * that were elided (spec Decision 18; §4 "everything lossy is reversible" —
 * and even lossless dedup keeps its originals retrievable).
 *
 * Each original is stored as a small JSON envelope keyed by its refId (the
 * sha256 of the original content), on top of the frozen BlobStore contract —
 * local directory by default, S3-compatible endpoint by config (Decision 12).
 *
 * Envelopes read back from disk are an external surface, so they are
 * zod-validated (CLAUDE.md conventions); a missing OR corrupt envelope maps
 * to UnknownRefError. Neither this class nor {@link LocalDirBlobStore}
 * implements eviction/pruning/a TTL (task ccr-ref-scope, 2026-08-22 —
 * confirmed by grep, not assumed), so "missing" here means "never stored, or
 * stored under a different {@link #location}" — never "expired". The thrown
 * error carries `location` and a `reason` distinguishing the two from a
 * corrupt envelope, rather than one "unknown or expired" for all three.
 */

import { z } from "zod";
import { UnknownRefError } from "../interfaces/compression.js";
import type { BlobStore } from "../interfaces/storage.js";
import { BlobNotFoundError } from "../interfaces/storage.js";

const envelopeSchema = z.object({
  v: z.literal(1),
  contentType: z.string(),
  originalTokens: z.number().int().nonnegative(),
  content: z.string(),
});

export type CcrEnvelope = z.infer<typeof envelopeSchema>;

export class CcrStore {
  readonly #blobs: BlobStore;
  /** In-flight putIfAbsent promises, keyed by refId — serializes concurrent writes (R8.22). */
  readonly #putLocks = new Map<string, Promise<boolean>>();
  /** Where this store is rooted, for {@link UnknownRefError}'s message. */
  readonly #location: string;

  constructor(blobs: BlobStore, location = "an unspecified CCR store") {
    this.#blobs = blobs;
    this.#location = location;
  }

  /**
   * Persist an original under its content hash. Content-addressed, so an
   * existing blob is already byte-identical — skip the write.
   * Returns true when a new blob was actually stored.
   *
   * Thread-safe: concurrent calls with the same refId share one in-flight write.
   * The second caller awaits the first's result and returns the same value
   * rather than writing a duplicate blob (R8.22).
   */
  async putIfAbsent(refId: string, envelope: CcrEnvelope): Promise<boolean> {
    const existing = this.#putLocks.get(refId);
    if (existing !== undefined) return existing;
    const promise = this.#doPut(refId, envelope);
    this.#putLocks.set(refId, promise);
    try {
      return await promise;
    } finally {
      this.#putLocks.delete(refId);
    }
  }

  async #doPut(refId: string, envelope: CcrEnvelope): Promise<boolean> {
    if (await this.#blobs.exists(refId)) {
      return false;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    await this.#blobs.put(refId, bytes, { contentType: "application/json" });
    return true;
  }

  /** Load and validate the envelope for `refId`; throws UnknownRefError. */
  async getEnvelope(refId: string): Promise<CcrEnvelope> {
    let bytes: Uint8Array;
    try {
      bytes = await this.#blobs.get(refId);
    } catch (err) {
      if (err instanceof BlobNotFoundError) {
        throw new UnknownRefError(refId, { location: this.#location, reason: "not-found" });
      }
      throw err;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(new TextDecoder().decode(bytes));
    } catch (err) {
      throw new UnknownRefError(refId, {
        location: this.#location,
        reason: "corrupt",
        detail: `invalid JSON (${err instanceof Error ? err.message : String(err)})`,
      });
    }
    const parsed = envelopeSchema.safeParse(parsedJson);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map(
          (issue) => `${issue.path.length > 0 ? issue.path.join(".") : "<root>"}: ${issue.message}`,
        )
        .join("; ");
      throw new UnknownRefError(refId, {
        location: this.#location,
        reason: "corrupt",
        detail: `envelope failed schema validation (${issues})`,
      });
    }
    return parsed.data;
  }
}
