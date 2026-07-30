/**
 * WS-E task E3 — `golem slider` get/set round-trip, including the slider-key
 * reconciliation: after `setSliderLevel` (which writes project-scope
 * `slider.level`), BOTH the config loader and the MCP JsonFileSliderStore
 * read the same value from the same file.
 */

import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { golemInitStatus, type InitProbe } from "../../src/cli/init.js";
import { getSliderInfo, setSliderLevel } from "../../src/cli/slider.js";
import { loadConfig, settingsFilePaths } from "../../src/config/index.js";
import { JsonFileSliderStore } from "../../src/mcp/slider-store.js";
import { rmTemp } from "../helpers/tmp.js";

// Fake probe (as in cli-init.test.ts): no real ~/.claude / ~/.vscode touched.
const okProbe: InitProbe = {
  claudeCodeInstalled: () => Promise.resolve(true),
  headroomWrapActive: () => Promise.resolve(false),
};

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
    await rm(join(projectDir, ".."), rmTemp);
  });

  it("defaults to level 1 (lossless) from the default layer", async () => {
    const info = await getSliderInfo({ projectDir, userDir });
    expect(info.level).toBe(1);
    expect(info.name).toBe("lossless");
    expect(info.layer).toBe("default");
  });

  it("round-trips a set through getSliderInfo with local provenance", async () => {
    const result = await setSliderLevel(3, { projectDir, userDir, probe: okProbe });
    expect(result.effective.level).toBe(3);
    // The slider writes to the gitignored local scope (spec Decision 43).
    expect(result.effective.layer).toBe("local");
    expect(result.overriddenBy).toBeUndefined();

    const info = await getSliderInfo({ projectDir, userDir });
    expect(info.level).toBe(3);
    expect(info.name).toBe("aggressive");
  });

  it("reconciles the config loader and the MCP slider store on ONE value", async () => {
    await setSliderLevel(3, { projectDir, userDir, probe: okProbe });

    // 1. The config loader sees slider.level = 3.
    const { settings } = await loadConfig({ projectDir, userDir });
    expect(settings.slider.level).toBe(3);

    // 2. The MCP slider store, pointed at the SAME local settings file, agrees.
    const localFile = settingsFilePaths({ projectDir, userDir }).local;
    const store = new JsonFileSliderStore(localFile);
    await expect(store.get()).resolves.toBe(3);

    // 3. A set via the MCP store is then visible to the config loader too.
    await store.set(2);
    const reloaded = await loadConfig({ projectDir, userDir });
    expect(reloaded.settings.slider.level).toBe(2);
    await expect(getSliderInfo({ projectDir, userDir })).resolves.toMatchObject({ level: 2 });
  });

  it("reports when a higher-precedence env layer overrides the written value", async () => {
    const result = await setSliderLevel(1, {
      projectDir,
      userDir,
      probe: okProbe,
      // Legacy env value 5 is accepted and migrated onto the 0–3 scale (→ 3).
      env: { GOLEM_SLIDER_LEVEL: "5" },
    });
    // Written at local scope, but env wins for the effective value.
    expect(result.effective.level).toBe(3);
    expect(result.effective.layer).toBe("env");
    expect(result.overriddenBy).toBeDefined();
    expect(result.overriddenBy?.level).toBe(3);
  });

  describe("activation gating", () => {
    it("does not create .golem/ or wire MCP/skills until a level is chosen", async () => {
      await expect(access(join(projectDir, ".golem"))).rejects.toThrow();
      await expect(access(join(projectDir, ".mcp.json"))).rejects.toThrow();
    });

    it("activates a not-yet-initialized project on the first setSliderLevel call", async () => {
      const before = await golemInitStatus(projectDir);
      expect(before.initialized).toBe(false);

      const result = await setSliderLevel(2, { projectDir, userDir, probe: okProbe });
      expect(result.justInitialized).toBe(true);
      expect(result.effective.level).toBe(2);

      const { settings } = await loadConfig({ projectDir, userDir });
      const after = await golemInitStatus(projectDir, settings.proxy.port);
      expect(after.initialized).toBe(true);
      await expect(access(join(projectDir, ".mcp.json"))).resolves.toBeUndefined();
      await expect(
        access(join(projectDir, ".claude", "skills", "golem", "slider", "SKILL.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(projectDir, ".claude", "rules", "golem-wiki-kb-first.md")),
      ).resolves.toBeUndefined();
    });

    it("does not re-run activation on an already-initialized project", async () => {
      await setSliderLevel(1, { projectDir, userDir, probe: okProbe });
      const result = await setSliderLevel(2, { projectDir, userDir, probe: okProbe });
      expect(result.justInitialized).toBeUndefined();
      expect(result.effective.level).toBe(2);
    });
  });
});
