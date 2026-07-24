/**
 * Last-served upstream model state (R6.2, src/proxy/served-model.ts): the
 * round-trip write/read, atomicity (no leftover temp file), and fail-open reads.
 */

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readServedModel,
  type ServedModel,
  servedModelPath,
  writeServedModel,
} from "../../../src/proxy/served-model.js";

describe("served-model state", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-served-model-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a written model", async () => {
    const state: ServedModel = { model: "kimi-k3", servedAtIso: "2026-07-24T00:00:00.000Z" };
    await writeServedModel(dir, state);
    expect(await readServedModel(dir)).toEqual(state);
  });

  it("leaves no .tmp file behind (atomic temp+rename)", async () => {
    await writeServedModel(dir, { model: "kimi-k3", servedAtIso: "2026-07-24T00:00:00.000Z" });
    const stateDir = path.dirname(servedModelPath(dir));
    const entries = await readdir(stateDir);
    expect(entries).toContain("served-model.json");
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  it("returns null when the file is missing", async () => {
    expect(await readServedModel(dir)).toBeNull();
  });

  it("returns null on a corrupt/invalid file rather than throwing", async () => {
    const file = servedModelPath(dir);
    await writeServedModel(dir, { model: "x", servedAtIso: "2026-07-24T00:00:00.000Z" });
    await writeFile(file, "{ not json", "utf8");
    expect(await readServedModel(dir)).toBeNull();
    // Wrong shape (missing servedAtIso) also reads back as null.
    await writeFile(file, JSON.stringify({ model: "x" }), "utf8");
    expect(await readServedModel(dir)).toBeNull();
  });

  it("strips a leading BOM before parsing", async () => {
    const file = servedModelPath(dir);
    const state: ServedModel = { model: "kimi-k3", servedAtIso: "2026-07-24T00:00:00.000Z" };
    await writeServedModel(dir, state); // ensures the .golem/state dir exists
    await writeFile(file, `﻿${JSON.stringify(state)}`, "utf8");
    expect(await readServedModel(dir)).toEqual(state);
  });
});
