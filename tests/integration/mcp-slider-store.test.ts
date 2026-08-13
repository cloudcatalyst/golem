/**
 * WS-B task B1 — JsonFileSliderStore persistence tests.
 *
 * The slider level persists at the NESTED `slider.level` path (the exact key
 * the E1 config schema validates — reconciled in WS-E task E3), preserving
 * unrelated keys so `golem slider`, `/mcp__golem__slider`, and the config
 * loader all see one value (verification-notes §20).
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SLIDER_LEVEL,
  JsonFileSliderStore,
  LEGACY_SLIDER_LEVEL_KEY,
} from "../../src/mcp/slider-store.js";
import { useTempDirs } from "../helpers/tmp.js";

const newTempDir = useTempDirs("golem-slider-");

describe("JsonFileSliderStore", () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(async () => {
    dir = await newTempDir();
    settingsPath = join(dir, "settings.json");
  });

  it("returns the default level when no settings file exists", async () => {
    const store = new JsonFileSliderStore(settingsPath);
    await expect(store.get()).resolves.toBe(DEFAULT_SLIDER_LEVEL);
  });

  it("persists a level at slider.level (creating parent dirs) and reads it back", async () => {
    const nested = join(dir, "deep", "er", "settings.json");
    const store = new JsonFileSliderStore(nested);
    await store.set(3);
    await expect(store.get()).resolves.toBe(3);
    // A fresh instance reads the same persisted value.
    await expect(new JsonFileSliderStore(nested).get()).resolves.toBe(3);

    // Written at the nested slider.level path the E1 config schema validates.
    const raw = JSON.parse(await readFile(nested, "utf8")) as Record<string, unknown>;
    expect(raw).toStrictEqual({ slider: { level: 3 } });
  });

  it("preserves unrelated sections and slider keys on write", async () => {
    await writeFile(
      settingsPath,
      JSON.stringify({ proxy: { port: 8787 }, slider: { local_only_opt_in: true } }),
      "utf8",
    );
    const store = new JsonFileSliderStore(settingsPath);
    await store.set(2);

    const raw = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    expect(raw).toStrictEqual({
      proxy: { port: 8787 },
      slider: { local_only_opt_in: true, level: 2 },
    });
  });

  it("reads a legacy flat slider_level key and migrates it away on write", async () => {
    await writeFile(settingsPath, JSON.stringify({ [LEGACY_SLIDER_LEVEL_KEY]: 3 }), "utf8");
    const store = new JsonFileSliderStore(settingsPath);
    // Legacy value is still readable before any write.
    await expect(store.get()).resolves.toBe(3);

    await store.set(3);
    const raw = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    expect(raw).toStrictEqual({ slider: { level: 3 } });
    expect(LEGACY_SLIDER_LEVEL_KEY in raw).toBe(false);
  });

  it("falls back to the default level on corrupt or invalid content", async () => {
    await writeFile(settingsPath, "{not json", "utf8");
    await expect(new JsonFileSliderStore(settingsPath).get()).resolves.toBe(DEFAULT_SLIDER_LEVEL);

    await writeFile(settingsPath, JSON.stringify({ slider: { level: 9 } }), "utf8");
    await expect(new JsonFileSliderStore(settingsPath).get()).resolves.toBe(DEFAULT_SLIDER_LEVEL);
  });
});
