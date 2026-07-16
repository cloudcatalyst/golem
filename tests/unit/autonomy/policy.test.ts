/**
 * R5.4 — autonomy level persistence + fail-closed read (ADR-0002).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  autonomyStatePath,
  DEFAULT_AUTONOMY_LEVEL,
  parseAutonomyLevel,
  readAutonomyLevel,
  writeAutonomyLevel,
} from "../../../src/autonomy/index.js";

describe("autonomy policy", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-autonomy-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("defaults to manual when nothing is persisted", async () => {
    expect(await readAutonomyLevel(dir)).toBe("manual");
    expect(DEFAULT_AUTONOMY_LEVEL).toBe("manual");
  });

  it("round-trips a written level", async () => {
    await writeAutonomyLevel(dir, "outcome", "2026-07-16T00:00:00.000Z");
    expect(await readAutonomyLevel(dir)).toBe("outcome");
  });

  it("fails CLOSED (→ manual) on an invalid/corrupt file, never throws", async () => {
    await mkdir(path.dirname(autonomyStatePath(dir)), { recursive: true });
    await writeFile(autonomyStatePath(dir), JSON.stringify({ level: "full-auto" }), "utf8");
    expect(await readAutonomyLevel(dir)).toBe("manual");
    await writeFile(autonomyStatePath(dir), "{ not json", "utf8");
    expect(await readAutonomyLevel(dir)).toBe("manual");
  });

  it("parseAutonomyLevel accepts valid levels and rejects others", () => {
    expect(parseAutonomyLevel("assisted")).toBe("assisted");
    expect(() => parseAutonomyLevel("turbo")).toThrow(/invalid autonomy level/);
  });
});
