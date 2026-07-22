/**
 * R5.4 — autonomy level persistence + fail-closed read (ADR-0002).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  autonomyStatePath,
  DEFAULT_AUTONOMY_GATE_ENABLED,
  DEFAULT_AUTONOMY_LEVEL,
  parseAutonomyLevel,
  readAutonomyGateEnabled,
  readAutonomyLevel,
  readAutonomyState,
  setAutonomyGateEnabled,
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

  // --- Gate enabled flag (Decision 40) ---
  it("gate is ENABLED by default (nothing persisted)", async () => {
    expect(DEFAULT_AUTONOMY_GATE_ENABLED).toBe(true);
    expect(await readAutonomyGateEnabled(dir)).toBe(true);
    expect(await readAutonomyState(dir)).toEqual({ level: "manual", enabled: true });
  });

  it("round-trips the enabled flag and preserves the level", async () => {
    await writeAutonomyLevel(dir, "outcome", "2026-07-22T00:00:00.000Z");
    await setAutonomyGateEnabled(dir, false, "2026-07-22T00:00:00.000Z");
    expect(await readAutonomyState(dir)).toEqual({ level: "outcome", enabled: false });
    // Re-enabling keeps the level.
    await setAutonomyGateEnabled(dir, true, "2026-07-22T00:00:00.000Z");
    expect(await readAutonomyState(dir)).toEqual({ level: "outcome", enabled: true });
  });

  it("preserves the enabled flag when the level is changed", async () => {
    await setAutonomyGateEnabled(dir, false, "2026-07-22T00:00:00.000Z");
    await writeAutonomyLevel(dir, "assisted", "2026-07-22T00:00:00.000Z");
    expect(await readAutonomyState(dir)).toEqual({ level: "assisted", enabled: false });
  });

  it("fails CLOSED (→ enabled) on a corrupt file — only explicit false disables", async () => {
    await mkdir(path.dirname(autonomyStatePath(dir)), { recursive: true });
    await writeFile(autonomyStatePath(dir), "{ not json", "utf8");
    expect(await readAutonomyGateEnabled(dir)).toBe(true);
    // A valid file with no `enabled` key → default ON.
    await writeFile(autonomyStatePath(dir), JSON.stringify({ level: "manual" }), "utf8");
    expect(await readAutonomyGateEnabled(dir)).toBe(true);
  });
});
