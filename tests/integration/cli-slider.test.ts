/**
 * WS-E task E3 — `golem slider` get/set round-trip, including the slider-key
 * reconciliation: after `setSliderLevel` (which writes project-scope
 * `slider.level`), BOTH the config loader and the MCP JsonFileSliderStore
 * read the same value from the same file.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSliderInfo, setSliderLevel } from "../../src/cli/slider.js";
import { loadConfig, settingsFilePaths } from "../../src/config/index.js";
import { JsonFileSliderStore } from "../../src/mcp/slider-store.js";

describe("golem slider", () => {
  let projectDir: string;
  let userDir: string;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "golem-slider-cli-"));
    projectDir = join(root, "project");
    userDir = join(root, "user");
    await mkdir(projectDir, { recursive: true });
    await mkdir(userDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(join(projectDir, ".."), { recursive: true, force: true });
  });

  it("defaults to level 1 (lossless) from the default layer", async () => {
    const info = await getSliderInfo({ projectDir, userDir });
    expect(info.level).toBe(1);
    expect(info.name).toBe("lossless");
    expect(info.layer).toBe("default");
  });

  it("round-trips a set through getSliderInfo with project provenance", async () => {
    const result = await setSliderLevel(4, { projectDir, userDir });
    expect(result.effective.level).toBe(4);
    expect(result.effective.layer).toBe("project");
    expect(result.overriddenBy).toBeUndefined();

    const info = await getSliderInfo({ projectDir, userDir });
    expect(info.level).toBe(4);
    expect(info.name).toBe("aggressive");
  });

  it("reconciles the config loader and the MCP slider store on ONE value", async () => {
    await setSliderLevel(3, { projectDir, userDir });

    // 1. The config loader sees slider.level = 3.
    const { settings } = await loadConfig({ projectDir, userDir });
    expect(settings.slider.level).toBe(3);

    // 2. The MCP slider store, pointed at the SAME project settings file, agrees.
    const projectFile = settingsFilePaths({ projectDir, userDir }).project;
    const store = new JsonFileSliderStore(projectFile);
    await expect(store.get()).resolves.toBe(3);

    // 3. A set via the MCP store is then visible to the config loader too.
    await store.set(5);
    const reloaded = await loadConfig({ projectDir, userDir });
    expect(reloaded.settings.slider.level).toBe(5);
    await expect(getSliderInfo({ projectDir, userDir })).resolves.toMatchObject({ level: 5 });
  });

  it("reports when a higher-precedence env layer overrides the written value", async () => {
    const result = await setSliderLevel(2, {
      projectDir,
      userDir,
      env: { GOLEM_SLIDER_LEVEL: "5" },
    });
    // Written at project scope, but env wins for the effective value.
    expect(result.effective.level).toBe(5);
    expect(result.effective.layer).toBe("env");
    expect(result.overriddenBy).toBeDefined();
    expect(result.overriddenBy?.level).toBe(5);
  });
});
