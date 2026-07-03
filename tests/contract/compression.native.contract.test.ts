/**
 * A2: registers the Golem-native lossless CompressionService against the
 * shared contract harness (IMPLEMENTATION_PLAN §2.1, spec Decision 18).
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeLosslessCompression } from "../../src/compression/index.js";
import { describeCompressionServiceContract } from "./compression-contract.js";

describeCompressionServiceContract("NativeLossless", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "golem-a2-contract-"));
  return NativeLosslessCompression.forProjectDir(projectRoot);
});
