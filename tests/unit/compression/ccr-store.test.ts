/**
 * CcrStore.getEnvelope's three failure shapes (task ccr-ref-scope, 2026-08-22).
 *
 * Before this task, every one of these — never stored, stored under a
 * different root, and a genuinely corrupt envelope — surfaced as the same
 * `UnknownRefError` with a bare "unknown CCR ref: <id>" message and no
 * mention of "expired" being real (it never was: grep confirms neither this
 * class nor LocalDirBlobStore implements eviction/pruning/a TTL). These tests
 * pin that the three are now distinguishable via `reason` and that the
 * message names `location` — "no envelope at <path>" is actionable, "unknown
 * or expired" was not.
 */

import { describe, expect, it } from "vitest";
import { CcrStore } from "../../../src/compression/ccr-store.js";
import { LocalDirBlobStore } from "../../../src/compression/index.js";
import { UnknownRefError } from "../../../src/interfaces/index.js";
import { useTempDirs } from "../../helpers/tmp.js";

const newTempDir = useTempDirs("golem-ccr-store-");

const REF_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("CcrStore.getEnvelope", () => {
  it('reason "not-found" for a refId nothing was ever stored under, naming the location', async () => {
    const root = await newTempDir();
    const store = new CcrStore(new LocalDirBlobStore(root), root);

    const err = await store.getEnvelope(REF_A).catch((e) => e);
    expect(err).toBeInstanceOf(UnknownRefError);
    const unknown = err as UnknownRefError;
    expect(unknown.reason).toBe("not-found");
    expect(unknown.location).toBe(root);
    expect(unknown.message).toContain(REF_A);
    expect(unknown.message).toContain(root);
    expect(unknown.message).not.toMatch(/expired/i);
  });

  it("defaults to a generic location when the store was constructed without one", async () => {
    const root = await newTempDir();
    const store = new CcrStore(new LocalDirBlobStore(root));

    const err = await store.getEnvelope(REF_A).catch((e) => e);
    expect(err).toBeInstanceOf(UnknownRefError);
    expect((err as UnknownRefError).location).toBe("an unspecified CCR store");
    expect((err as UnknownRefError).message).toContain("an unspecified CCR store");
  });

  it('reason "corrupt" for a stored blob that is not valid JSON', async () => {
    const root = await newTempDir();
    const blobs = new LocalDirBlobStore(root);
    await blobs.put(REF_A, new TextEncoder().encode("{ not json"));
    const store = new CcrStore(blobs, root);

    const err = await store.getEnvelope(REF_A).catch((e) => e);
    expect(err).toBeInstanceOf(UnknownRefError);
    const unknown = err as UnknownRefError;
    expect(unknown.reason).toBe("corrupt");
    expect(unknown.location).toBe(root);
    expect(unknown.message).toMatch(/invalid JSON/i);
  });

  it('reason "corrupt" for well-formed JSON that fails the envelope schema', async () => {
    const root = await newTempDir();
    const blobs = new LocalDirBlobStore(root);
    // Missing every required field.
    await blobs.put(REF_A, new TextEncoder().encode(JSON.stringify({ oops: true })));
    const store = new CcrStore(blobs, root);

    const err = await store.getEnvelope(REF_A).catch((e) => e);
    expect(err).toBeInstanceOf(UnknownRefError);
    const unknown = err as UnknownRefError;
    expect(unknown.reason).toBe("corrupt");
    expect(unknown.message).toMatch(/schema validation/i);
  });

  it("round-trips a genuinely present, valid envelope without throwing", async () => {
    const root = await newTempDir();
    const store = new CcrStore(new LocalDirBlobStore(root), root);
    await store.putIfAbsent(REF_A, {
      v: 1,
      contentType: "text/plain",
      originalTokens: 3,
      content: "hi",
    });

    await expect(store.getEnvelope(REF_A)).resolves.toEqual({
      v: 1,
      contentType: "text/plain",
      originalTokens: 3,
      content: "hi",
    });
  });
});

describe("UnknownRefError", () => {
  it("distinguishes not-found from corrupt in its message text", () => {
    const notFound = new UnknownRefError("r1", { location: "/x", reason: "not-found" });
    const corrupt = new UnknownRefError("r1", {
      location: "/x",
      reason: "corrupt",
      detail: "boom",
    });
    expect(notFound.message).not.toBe(corrupt.message);
    expect(notFound.message).toMatch(/never stored, or it was stored under a different/);
    expect(corrupt.message).toMatch(/exists but cannot be read back/);
    expect(corrupt.message).toContain("boom");
  });

  it("defaults reason to not-found and location to an unspecified store when omitted", () => {
    const err = new UnknownRefError("r1");
    expect(err.reason).toBe("not-found");
    expect(err.location).toBe("an unspecified CCR store");
    expect(err.name).toBe("UnknownRefError");
  });
});
