/**
 * A2: registers the default local-directory BlobStore (backing the CCR store)
 * against the shared BlobStore contract harness.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDirBlobStore } from "../../src/compression/index.js";
import { describeBlobStoreContract } from "./storage-contract.js";

describeBlobStoreContract("LocalDirBlobStore", async () => {
  const root = await mkdtemp(join(tmpdir(), "golem-a2-blobs-"));
  return new LocalDirBlobStore(root);
});
