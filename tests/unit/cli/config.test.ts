/**
 * Unit tests for the `golem config` engine (E1b).
 *
 * These tests avoid touching real user/project settings files by writing to a
 * temp project dir and using a separate user dir.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getConfig,
  listConfig,
  parseConfigValue,
  renderConfigGet,
  renderConfigList,
  renderConfigSet,
  renderConfigUnset,
  setConfig,
  unsetConfig,
} from "../../../src/cli/config.js";
import { ConfigError } from "../../../src/config/errors.js";
import { writeSetting } from "../../../src/config/index.js";

describe("config engine", () => {
  let projectDir: string;
  let userDir: string;

  beforeEach(async () => {
    const base = await mkdtemp(path.join(tmpdir(), "golem-config-"));
    projectDir = path.join(base, "project");
    userDir = path.join(base, "user");
    await writeSetting("project", "proxy.port", 12345, { projectDir });
  });

  afterEach(async () => {
    await rm(path.dirname(projectDir), { recursive: true, force: true });
  });

  function opts() {
    return { projectDir, userDir };
  }

  describe("listConfig", () => {
    it("includes the default value when nothing is set", async () => {
      const report = await listConfig(opts());
      const entry = report.entries.find((e) => e.key === "slider.level");
      expect(entry).toEqual({ key: "slider.level", value: 1, layer: "default" });
    });

    it("reflects a project-layer override", async () => {
      await writeSetting("project", "slider.level", 2, { projectDir });
      const report = await listConfig(opts());
      const entry = report.entries.find((e) => e.key === "slider.level");
      expect(entry).toEqual({
        key: "slider.level",
        value: 2,
        layer: "project",
        source: path.join(projectDir, ".golem", "settings.json"),
      });
    });
  });

  describe("getConfig", () => {
    it("returns the effective value and layer", async () => {
      await writeSetting("project", "inference.local_coder_enabled", false, { projectDir });
      const report = await getConfig("inference.local_coder_enabled", opts());
      expect(report.value).toBe(false);
      expect(report.layer).toBe("project");
    });

    it("rejects unknown keys", async () => {
      await expect(getConfig("not.real", opts())).rejects.toBeInstanceOf(ConfigError);
    });
  });

  describe("parseConfigValue", () => {
    it("parses booleans flexibly", () => {
      expect(parseConfigValue("inference.local_coder_enabled", "true")).toBe(true);
      expect(parseConfigValue("inference.local_coder_enabled", "no")).toBe(false);
      expect(parseConfigValue("inference.local_coder_enabled", "1")).toBe(true);
      expect(parseConfigValue("inference.local_coder_enabled", "OFF")).toBe(false);
    });

    it("parses numbers", () => {
      expect(parseConfigValue("proxy.port", "4930")).toBe(4930);
    });

    it("parses comma-separated and JSON arrays", () => {
      expect(parseConfigValue("knowledge.watch_paths", "a,b, c")).toEqual(["a", "b", "c"]);
      expect(parseConfigValue("knowledge.watch_paths", '["x", "y"]')).toEqual(["x", "y"]);
    });

    it("passes strings through", () => {
      expect(parseConfigValue("proxy.upstream_base_url", "https://api.anthropic.com")).toBe(
        "https://api.anthropic.com",
      );
    });

    it("rejects invalid booleans", () => {
      expect(() => parseConfigValue("inference.local_coder_enabled", "maybe")).toThrow(ConfigError);
    });
  });

  describe("setConfig", () => {
    it("writes and reports the effective value", async () => {
      const result = await setConfig("project", "slider.level", "2", opts());
      expect(result.value).toBe(2);
      expect(result.scope).toBe("project");
      expect(result.effective.value).toBe(2);
      expect(result.effective.layer).toBe("project");
    });

    it("reports when a higher layer overrides the written value", async () => {
      await writeSetting("local", "slider.level", 3, { projectDir });
      const result = await setConfig("project", "slider.level", "2", opts());
      expect(result.overriddenBy).toBeDefined();
      expect(result.effective.value).toBe(3);
    });

    it("rejects invalid values", async () => {
      await expect(setConfig("project", "slider.level", "99", opts())).rejects.toBeInstanceOf(
        ConfigError,
      );
    });
  });

  describe("unsetConfig", () => {
    it("removes the key and falls back to a lower layer", async () => {
      await writeSetting("project", "slider.level", 2, { projectDir });
      const result = await unsetConfig("project", "slider.level", opts());
      expect(result.effective.value).toBe(1);
      expect(result.effective.layer).toBe("default");
    });
  });

  describe("renderers", () => {
    it("renderConfigList prints keys and layers", () => {
      const out = renderConfigList({
        entries: [{ key: "slider.level", value: 2, layer: "project", source: "/x" }],
      });
      expect(out).toContain("slider.level = 2 — project (/x)");
    });

    it("renderConfigGet prints one key", () => {
      const out = renderConfigGet({ key: "slider.level", value: 1, layer: "default" });
      expect(out).toContain("slider.level = 1 — default");
    });

    it("renderConfigSet prints the file and effective value", () => {
      const out = renderConfigSet({
        key: "slider.level",
        value: 2,
        scope: "project",
        file: "/project/.golem/settings.json",
        effective: { key: "slider.level", value: 2, layer: "project" },
      });
      expect(out).toContain("slider.level set to 2 in /project/.golem/settings.json");
    });

    it("renderConfigUnset prints the fallback", () => {
      const out = renderConfigUnset({
        key: "slider.level",
        scope: "project",
        file: "/project/.golem/settings.json",
        effective: { key: "slider.level", value: 1, layer: "default" },
      });
      expect(out).toContain("slider.level removed from project scope");
      expect(out).toContain("effective value: 1 — default");
    });
  });
});
