/**
 * Last-served upstream model state (R6.2, src/proxy/served-model.ts): the
 * round-trip write/read, atomicity (no leftover temp file), and fail-open reads.
 */

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearServedModel,
  readServedModel,
  type ServedModel,
  servedModelFor,
  servedModelPath,
  writeServedModel,
} from "../../../src/proxy/served-model.js";
import { rmTemp } from "../../helpers/tmp.js";

describe("served-model state", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-served-model-"));
  });
  afterEach(async () => {
    await rm(dir, rmTemp);
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

  it("round-trips the account the model was served on", async () => {
    const state: ServedModel = {
      model: "kimi-k3",
      servedAtIso: "2026-07-29T00:00:00.000Z",
      accountId: "kimi",
    };
    await writeServedModel(dir, state);
    expect(await readServedModel(dir)).toEqual(state);
  });

  it("clearServedModel removes the snapshot, and is a no-op when there is none", async () => {
    await writeServedModel(dir, { model: "kimi-k3", servedAtIso: "2026-07-29T00:00:00.000Z" });
    await clearServedModel(dir);
    expect(await readServedModel(dir)).toBeNull();
    await expect(clearServedModel(dir)).resolves.toBeUndefined();
  });
});

/**
 * The account-scoped read. The bug it fixes: after `golem gateway use <other>`
 * the snapshot still described the PREVIOUS upstream, so `status`, the statusline,
 * and the VS Code status bar all reported the old model as the current one.
 */
describe("servedModelFor", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-served-for-"));
  });
  afterEach(async () => {
    await rm(dir, rmTemp);
  });

  it("returns the snapshot when it was served on the active account", async () => {
    await writeServedModel(dir, {
      model: "kimi-k3",
      servedAtIso: "2026-07-29T00:00:00.000Z",
      accountId: "kimi",
    });
    expect((await servedModelFor(dir, "kimi"))?.model).toBe("kimi-k3");
  });

  it("returns null for a snapshot from a DIFFERENT account (the stale-model bug)", async () => {
    await writeServedModel(dir, {
      model: "kimi-k3",
      servedAtIso: "2026-07-29T00:00:00.000Z",
      accountId: "kimi",
    });
    expect(await servedModelFor(dir, "work")).toBeNull();
    // …including after reverting to the top-level (default) upstream.
    expect(await servedModelFor(dir, null)).toBeNull();
  });

  it("matches the top-level upstream via a null accountId", async () => {
    await writeServedModel(dir, {
      model: "claude-opus-4-8",
      servedAtIso: "2026-07-29T00:00:00.000Z",
      accountId: null,
    });
    expect((await servedModelFor(dir, null))?.model).toBe("claude-opus-4-8");
    expect(await servedModelFor(dir, "kimi")).toBeNull();
  });

  /** A pre-existing snapshot has no accountId; accept it only for the default. */
  it("treats a legacy snapshot with no accountId as the top-level upstream", async () => {
    await writeServedModel(dir, {
      model: "claude-opus-4-8",
      servedAtIso: "2026-07-29T00:00:00.000Z",
    });
    expect((await servedModelFor(dir, null))?.model).toBe("claude-opus-4-8");
    expect(await servedModelFor(dir, "kimi")).toBeNull();
  });

  it("returns null when there is no snapshot at all", async () => {
    expect(await servedModelFor(dir, null)).toBeNull();
  });
});
