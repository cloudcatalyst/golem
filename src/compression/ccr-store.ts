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
 * to UnknownRefError ("does not exist or was evicted").
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

  constructor(blobs: BlobStore) {
    this.#blobs = blobs;
  }

  /**
   * Persist an original under its content hash. Content-addressed, so an
   * existing blob is already byte-identical — skip the write.
   * Returns true when a new blob was actually stored.
   */
  async putIfAbsent(refId: string, envelope: CcrEnvelope): Promise<boolean> {
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
        throw new UnknownRefError(refId);
      }
      throw err;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new UnknownRefError(refId);
    }
    const parsed = envelopeSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new UnknownRefError(refId);
    }
    return parsed.data;
  }
}
