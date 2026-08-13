/** E1: layer precedence, defaults, provenance, freezing. */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  findProjectDir,
  loadConfig,
  policyFromSettings,
} from "../../src/config/index.js";
import { useTempDirs } from "../helpers/tmp.js";

let base: string;
let userDir: string;
let projectDir: string;

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const userFile = (): string => path.join(userDir, "settings.json");
const projectFile = (): string => path.join(projectDir, ".golem", "settings.json");
const localFile = (): string => path.join(projectDir, ".golem", "settings.local.json");

const newTempDir = useTempDirs("golem-config-test-");

beforeEach(async () => {
  base = await newTempDir();
  userDir = path.join(base, "user-golem");
  projectDir = path.join(base, "project");
  await mkdir(projectDir, { recursive: true });
});

describe("loadConfig precedence", () => {
  it("returns pure defaults when no files, env, or overrides exist", async () => {
    const config = await loadConfig({ projectDir, userDir, env: {} });
    expect(config.settings).toEqual(DEFAULT_SETTINGS);
    expect(config.warnings).toEqual([]);
    for (const entry of Object.values(config.provenance)) {
      expect(entry.layer).toBe("default");
    }
    expect(config.files.user).toBe(userFile());
    expect(config.files.project).toBe(projectFile());
    expect(config.files.local).toBe(localFile());
  });

  it("user settings override defaults", async () => {
    await writeJson(userFile(), { slider: { level: 2 } });
    const config = await loadConfig({ projectDir, userDir, env: {} });
    expect(config.settings.slider.level).toBe(2);
    expect(config.provenance["slider.level"]).toEqual({
      layer: "user",
      source: userFile(),
    });
    // Untouched sibling section keeps its default + provenance.
    expect(config.settings.proxy.port).toBe(4653);
    expect(config.provenance["proxy.port"]).toEqual({ layer: "default" });
  });

  it("project overrides user, local overrides project", async () => {
    await writeJson(userFile(), { slider: { level: 0 }, proxy: { port: 5000 } });
    await writeJson(projectFile(), { slider: { level: 1 } });
    await writeJson(localFile(), { slider: { level: 2 } });
    const config = await loadConfig({ projectDir, userDir, env: {} });
    expect(config.settings.slider.level).toBe(2);
    expect(config.provenance["slider.level"]).toEqual({
      layer: "local",
      source: localFile(),
    });
    // proxy.port from the user layer survives untouched by higher layers.
    expect(config.settings.proxy.port).toBe(5000);
    expect(config.provenance["proxy.port"]).toEqual({
      layer: "user",
      source: userFile(),
    });
  });

  it("env overrides local; per-request overrides beat env", async () => {
    await writeJson(localFile(), { slider: { level: 1 } });
    // Legacy env value 5 is accepted and migrated onto the 0–3 scale (→ 3).
    const env = { GOLEM_SLIDER_LEVEL: "5", GOLEM_TELEMETRY_ENABLED: "false" };

    const envOnly = await loadConfig({ projectDir, userDir, env });
    expect(envOnly.settings.slider.level).toBe(3);
    expect(envOnly.settings.telemetry.enabled).toBe(false);
    expect(envOnly.provenance["slider.level"]).toEqual({
      layer: "env",
      source: "GOLEM_SLIDER_LEVEL",
    });

    const withOverrides = await loadConfig({
      projectDir,
      userDir,
      env,
      overrides: { slider: { level: 0 } },
    });
    expect(withOverrides.settings.slider.level).toBe(0);
    expect(withOverrides.provenance["slider.level"]).toEqual({ layer: "override" });
    // env value not shadowed by overrides still wins over defaults.
    expect(withOverrides.settings.telemetry.enabled).toBe(false);
  });

  it("merges per leaf across layers (arrays replace wholesale)", async () => {
    await writeJson(userFile(), {
      inference: { ollama_base_url: "http://lab:11434" },
      knowledge: { watch_paths: ["a", "b"] },
    });
    await writeJson(projectFile(), { knowledge: { watch_paths: ["c"] } });
    const config = await loadConfig({ projectDir, userDir, env: {} });
    expect(config.settings.inference.ollama_base_url).toBe("http://lab:11434");
    expect(config.settings.knowledge.watch_paths).toEqual(["c"]);
  });

  it("returns a deeply frozen settings object", async () => {
    await writeJson(projectFile(), { knowledge: { watch_paths: ["x"] } });
    const config = await loadConfig({ projectDir, userDir, env: {} });
    expect(Object.isFrozen(config.settings)).toBe(true);
    expect(Object.isFrozen(config.settings.proxy)).toBe(true);
    expect(Object.isFrozen(config.settings.knowledge.watch_paths)).toBe(true);
    expect(Object.isFrozen(config.provenance)).toBe(true);
    expect(() => {
      (config.settings.slider as { level: number }).level = 5;
    }).toThrow(TypeError);
  });

  it("treats empty and BOM-prefixed files gracefully", async () => {
    await mkdir(path.dirname(projectFile()), { recursive: true });
    await writeFile(projectFile(), "   \n", "utf8");
    await writeFile(localFile(), `﻿{"slider":{"level":3}}`, "utf8");
    const config = await loadConfig({ projectDir, userDir, env: {} });
    expect(config.settings.slider.level).toBe(3);
  });

  it("defaults knowledge.wiki_dir to docs/wiki and lets layers override it", async () => {
    const defaults = await loadConfig({ projectDir, userDir, env: {} });
    expect(defaults.settings.knowledge.wiki_dir).toBe("docs/wiki");
    expect(defaults.provenance["knowledge.wiki_dir"]).toEqual({ layer: "default" });

    await writeJson(projectFile(), { knowledge: { wiki_dir: "notes/wiki" } });
    const config = await loadConfig({ projectDir, userDir, env: {} });
    expect(config.settings.knowledge.wiki_dir).toBe("notes/wiki");
    expect(config.provenance["knowledge.wiki_dir"]).toEqual({
      layer: "project",
      source: projectFile(),
    });
  });

  it("policyFromSettings maps slider settings onto the frozen contract", async () => {
    // Legacy 5 migrates to 3 (aggressive).
    await writeJson(projectFile(), { slider: { level: 5 } });
    const config = await loadConfig({ projectDir, userDir, env: {} });
    const policy = policyFromSettings(config.settings);
    expect(policy.level).toBe(3);
    expect(policy.stages.semanticCompression).toBe("aggressive");
  });

  describe("findProjectDir", () => {
    it("returns the directory containing .golem/settings.json", async () => {
      await writeJson(projectFile(), {});
      expect(findProjectDir(projectDir)).toBe(projectDir);
    });

    it("walks up from a subdirectory to the project root", async () => {
      await writeJson(projectFile(), {});
      const sub = path.join(projectDir, "src", "cli");
      expect(findProjectDir(sub)).toBe(projectDir);
    });

    it("returns null when no ancestor has .golem/settings.json", async () => {
      const orphan = path.join(base, "no-golem-here");
      await mkdir(orphan, { recursive: true });
      // Cap the walk at `base` so the test doesn't find a real .golem/ in the
      // developer's home directory (common on Windows, where os.tmpdir() nests
      // under C:\Users\<name>).
      expect(findProjectDir(orphan, base)).toBeNull();
    });

    it("returns the deepest matching project (closest ancestor)", async () => {
      const nested = path.join(projectDir, "packages", "api");
      await writeJson(projectFile(), {});
      const nestedProjectFile = path.join(nested, ".golem", "settings.json");
      await writeJson(nestedProjectFile, {});
      const deepSub = path.join(nested, "src");
      expect(findProjectDir(deepSub)).toBe(nested);
    });
  });
});
