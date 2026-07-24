/**
 * local-model cache writer must never bootstrap a `.golem/` folder — the status
 * line runs in every Claude Code project and only Golem-initialized projects
 * (those with a `.golem/` dir) should be written to (reported 2026-07-22).
 */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  golemDirExists,
  localModelCachePath,
  readLocalModelCache,
  writeLocalModelCache,
} from "../../../src/cli/local-model.js";

describe("local-model cache", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-lm-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("golemDirExists", () => {
    it("is false for a bare project dir", async () => {
      expect(await golemDirExists(dir)).toBe(false);
    });

    it("is true once .golem exists", async () => {
      await mkdir(path.join(dir, ".golem"), { recursive: true });
      expect(await golemDirExists(dir)).toBe(true);
    });
  });

  describe("writeLocalModelCache", () => {
    it("does NOT create .golem in a non-Golem project (no-op)", async () => {
      await writeLocalModelCache(dir, true);
      expect(await golemDirExists(dir)).toBe(false);
      expect(await readLocalModelCache(dir)).toBeNull();
    });

    it("writes the cache (creating state/) when .golem already exists", async () => {
      await mkdir(path.join(dir, ".golem"), { recursive: true });
      await writeLocalModelCache(dir, true);

      const cached = await readLocalModelCache(dir);
      expect(cached?.reachable).toBe(true);
      const raw = await readFile(localModelCachePath(dir), "utf8");
      expect(JSON.parse(raw).reachable).toBe(true);
    });

    it("persists the coder model when given, and round-trips it", async () => {
      await mkdir(path.join(dir, ".golem"), { recursive: true });
      await writeLocalModelCache(dir, true, "qwen2.5-coder:7b");

      const cached = await readLocalModelCache(dir);
      expect(cached?.reachable).toBe(true);
      expect(cached?.coderModel).toBe("qwen2.5-coder:7b");
    });

    it("omits the coder model key when empty/absent (exactOptionalPropertyTypes)", async () => {
      await mkdir(path.join(dir, ".golem"), { recursive: true });
      await writeLocalModelCache(dir, false, "");

      const raw = JSON.parse(await readFile(localModelCachePath(dir), "utf8"));
      expect("coderModel" in raw).toBe(false);
    });
  });
});
