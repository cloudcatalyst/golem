/**
 * R5.2 — recursive directory sizing for the sidecar session-state report.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dirSizeBytes, golemStorageSizes } from "../../../src/cli/storage-size.js";
import { rmTemp } from "../../helpers/tmp.js";

describe("dirSizeBytes", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-storage-"));
  });
  afterEach(async () => {
    await rm(dir, rmTemp);
  });

  it("returns 0 for a missing directory (never throws)", async () => {
    expect(await dirSizeBytes(path.join(dir, "nope"))).toBe(0);
  });

  it("sums file sizes recursively across subdirectories", async () => {
    await writeFile(path.join(dir, "a.txt"), "12345"); // 5 bytes
    await mkdir(path.join(dir, "sub"), { recursive: true });
    await writeFile(path.join(dir, "sub", "b.txt"), "6789"); // 4 bytes
    expect(await dirSizeBytes(dir)).toBe(9);
  });
});

describe("golemStorageSizes", () => {
  let proj: string;
  beforeEach(async () => {
    proj = await mkdtemp(path.join(tmpdir(), "golem-proj-"));
  });
  afterEach(async () => {
    await rm(proj, rmTemp);
  });

  it("measures the four .golem stores, 0 for absent ones", async () => {
    await mkdir(path.join(proj, ".golem", "ccr"), { recursive: true });
    await writeFile(path.join(proj, ".golem", "ccr", "blob"), "hello world"); // 11 bytes
    const sizes = await golemStorageSizes(proj);
    expect(sizes.ccr_bytes).toBe(11);
    expect(sizes.knowledge_bytes).toBe(0);
    expect(sizes.telemetry_bytes).toBe(0);
    expect(sizes.webcache_bytes).toBe(0);
  });
});
