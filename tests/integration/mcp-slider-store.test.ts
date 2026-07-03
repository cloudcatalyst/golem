/**
 * WS-B task B1 — JsonFileSliderStore persistence tests.
 *
 * The slider level persists as the snake_case `slider_level` key in a JSON
 * settings file (CLAUDE.md conventions), preserving unrelated keys so WS-E's
 * config loader (task E1) can take ownership of the same file later.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SLIDER_LEVEL,
  JsonFileSliderStore,
  SLIDER_LEVEL_SETTINGS_KEY,
} from "../../src/mcp/slider-store.js";

describe("JsonFileSliderStore", () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "golem-slider-"));
    settingsPath = join(dir, "settings.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the default level when no settings file exists", async () => {
    const store = new JsonFileSliderStore(settingsPath);
    await expect(store.get()).resolves.toBe(DEFAULT_SLIDER_LEVEL);
  });

  it("persists a level (creating parent directories) and reads it back", async () => {
    const nested = join(dir, "deep", "er", "settings.json");
    const store = new JsonFileSliderStore(nested);
    await store.set(4);
    await expect(store.get()).resolves.toBe(4);
    // A fresh instance reads the same persisted value.
    await expect(new JsonFileSliderStore(nested).get()).resolves.toBe(4);

    const raw = JSON.parse(await readFile(nested, "utf8")) as Record<string, unknown>;
    expect(raw).toStrictEqual({ [SLIDER_LEVEL_SETTINGS_KEY]: 4 });
  });

  it("preserves unrelated snake_case settings keys on write", async () => {
    await writeFile(
      settingsPath,
      JSON.stringify({ proxy_port: 8787, telemetry_enabled: false }),
      "utf8",
    );
    const store = new JsonFileSliderStore(settingsPath);
    await store.set(2);

    const raw = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    expect(raw).toStrictEqual({
      proxy_port: 8787,
      telemetry_enabled: false,
      [SLIDER_LEVEL_SETTINGS_KEY]: 2,
    });
  });

  it("falls back to the default level on corrupt or invalid content", async () => {
    await writeFile(settingsPath, "{not json", "utf8");
    await expect(new JsonFileSliderStore(settingsPath).get()).resolves.toBe(DEFAULT_SLIDER_LEVEL);

    await writeFile(settingsPath, JSON.stringify({ [SLIDER_LEVEL_SETTINGS_KEY]: 9 }), "utf8");
    await expect(new JsonFileSliderStore(settingsPath).get()).resolves.toBe(DEFAULT_SLIDER_LEVEL);
  });
});
