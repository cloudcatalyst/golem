/**
 * Unit tests for the `golem config` engine (E1b).
 *
 * These tests avoid touching real user/project settings files by writing to a
 * temp project dir and using a separate user dir.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  getConfig,
  listConfig,
  parseConfigValue,
  renderConfigGet,
  renderConfigList,
  renderConfigSet,
  renderConfigUnset,
  resolveSetValue,
  setConfig,
  unsetConfig,
} from "../../../src/cli/config.js";
import { ConfigError } from "../../../src/config/errors.js";
import { writeSetting } from "../../../src/config/index.js";
import { allLeafPaths, leafSchema } from "../../../src/config/schema.js";
import { unwrapSchema } from "../../../src/config/ui-model.js";
import { rmTemp } from "../../helpers/tmp.js";

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
    await rm(path.dirname(projectDir), rmTemp);
  });

  function opts() {
    return { projectDir, userDir };
  }

  describe("listConfig", () => {
    it("includes the default value when nothing is set", async () => {
      const report = await listConfig(opts());
      const entry = report.entries.find((e) => e.key === "compression.level");
      expect(entry).toEqual({ key: "compression.level", value: "1", layer: "default" });
    });

    it("reflects a project-layer override", async () => {
      await writeSetting("project", "compression.level", "2", { projectDir });
      const report = await listConfig(opts());
      const entry = report.entries.find((e) => e.key === "compression.level");
      expect(entry).toEqual({
        key: "compression.level",
        value: "2",
        layer: "project",
        source: path.join(projectDir, ".golem", "settings.json"),
      });
    });
  });

  describe("getConfig", () => {
    it("returns the effective value and layer", async () => {
      await writeSetting("project", "inference.default_target", "gpt-4o", { projectDir });
      const report = await getConfig("inference.default_target", opts());
      expect(report.value).toBe("gpt-4o");
      expect(report.layer).toBe("project");
    });

    it("rejects unknown keys", async () => {
      await expect(getConfig("not.real", opts())).rejects.toBeInstanceOf(ConfigError);
    });
  });

  describe("parseConfigValue", () => {
    it("parses booleans flexibly", () => {
      expect(parseConfigValue("inference.default_target", "gpt-4o")).toBe("gpt-4o");
      expect(parseConfigValue("inference.default_target", "sonnet")).toBe("sonnet");
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
      expect(parseConfigValue("inference.default_target", "maybe")).toBe("maybe");
    });

    // R9.9 — object-valued leaves were unreachable from the CLI: the raw string
    // went to zod untouched and failed with "Expected object, received string".
    it("parses a JSON object for a record leaf", () => {
      expect(parseConfigValue("compression.headroom_config", '{"protect_recent":6}')).toEqual({
        protect_recent: 6,
      });
    });

    it("parses nested JSON for a record leaf", () => {
      expect(
        parseConfigValue(
          "compression.headroom_config",
          '{"smart_crusher":{"lossless_only":true},"protect_recent":6}',
        ),
      ).toEqual({ smart_crusher: { lossless_only: true }, protect_recent: 6 });
    });

    it("accepts an empty object to clear a record leaf", () => {
      expect(parseConfigValue("compression.headroom_config", "{}")).toEqual({});
    });

    it("names the cause when the JSON is malformed, not the zod symptom", () => {
      expect(() => parseConfigValue("compression.headroom_config", "{protect_recent:6}")).toThrow(
        /invalid JSON for "compression\.headroom_config"/,
      );
      // and it points at the quoting escape hatch
      expect(() => parseConfigValue("compression.headroom_config", "{protect_recent:6}")).toThrow(
        /--value-file/,
      );
    });

    it("rejects valid JSON of the wrong shape", () => {
      expect(() => parseConfigValue("compression.headroom_config", "[1,2]")).toThrow(
        /expects a JSON object, got array/,
      );
      expect(() => parseConfigValue("compression.headroom_config", "null")).toThrow(
        /expects a JSON object, got null/,
      );
    });

    // The gate: not special-cased to headroom_config — every object/record leaf
    // in the schema must be settable from the CLI.
    it("every object-valued leaf in the schema is settable", () => {
      const objectLeaves: string[] = [];
      for (const leafPath of allLeafPaths()) {
        const [section, key] = leafPath.split(".", 2) as [string, string];
        const leaf = leafSchema(section, key);
        if (leaf === undefined) continue;
        const target = unwrapSchema(leaf);
        if (target instanceof z.ZodRecord || target instanceof z.ZodObject) {
          objectLeaves.push(leafPath);
        }
      }
      // If this is empty the test is vacuous — the schema has at least
      // compression.headroom_config and inference.worker_targets.
      expect(objectLeaves).toContain("compression.headroom_config");
      expect(objectLeaves.length).toBeGreaterThan(0);
      for (const leafPath of objectLeaves) {
        expect(parseConfigValue(leafPath, "{}"), leafPath).toEqual({});
      }
    });
  });

  describe("resolveSetValue", () => {
    it("returns the positional value when given", async () => {
      await expect(resolveSetValue("hello", undefined)).resolves.toBe("hello");
    });

    it("reads --value-file and trims it", async () => {
      const file = path.join(projectDir, "value.json");
      await mkdir(projectDir, { recursive: true });
      await writeFile(file, '{"protect_recent":6}\n', "utf8");
      await expect(resolveSetValue(undefined, file)).resolves.toBe('{"protect_recent":6}');
    });

    it("strips a UTF-8 BOM, which Windows editors add and JSON.parse rejects", async () => {
      const file = path.join(projectDir, "bom.json");
      await mkdir(projectDir, { recursive: true });
      // Built at runtime, not a literal: an invisible BOM lost in an edit
      // would leave this test passing while proving nothing.
      const withBom = `${String.fromCharCode(0xfeff)}{"protect_recent":6}\n`;
      expect(withBom.charCodeAt(0)).toBe(0xfeff);
      await writeFile(file, withBom, "utf8");
      const raw = await resolveSetValue(undefined, file);
      expect(raw).toBe('{"protect_recent":6}');
      expect(parseConfigValue("compression.headroom_config", raw)).toEqual({ protect_recent: 6 });
    });

    it("reads stdin for --value-file -", async () => {
      await expect(
        resolveSetValue(undefined, "-", { readStdin: async () => ' {"a":1} \n' }),
      ).resolves.toBe('{"a":1}');
    });

    it("refuses both sources at once rather than silently preferring one", async () => {
      await expect(resolveSetValue("x", "/tmp/f")).rejects.toBeInstanceOf(ConfigError);
    });

    it("refuses neither source", async () => {
      await expect(resolveSetValue(undefined, undefined)).rejects.toThrow(/--value-file/);
    });

    it("names the file it could not read", async () => {
      const missing = path.join(projectDir, "nope.json");
      await expect(resolveSetValue(undefined, missing)).rejects.toThrow(/cannot read --value-file/);
    });
  });

  describe("setConfig", () => {
    it("writes and reports the effective value", async () => {
      const result = await setConfig("project", "compression.level", "2", opts());
      expect(result.value).toBe("2");
      expect(result.scope).toBe("project");
      expect(result.effective.value).toBe("2");
      expect(result.effective.layer).toBe("project");
    });

    it("reports when a higher layer overrides the written value", async () => {
      await writeSetting("local", "compression.level", "3", { projectDir });
      const result = await setConfig("project", "compression.level", "2", opts());
      expect(result.overriddenBy).toBeDefined();
      expect(result.effective.value).toBe("3");
    });

    it("rejects invalid values", async () => {
      await expect(setConfig("project", "compression.level", "99", opts())).rejects.toBeInstanceOf(
        ConfigError,
      );
    });

    // R9.9 — the motivating case from the task: this used to fail with
    // "Expected object, received string" and could only be done by hand-editing.
    it("writes an object-valued leaf and reports it as not overridden", async () => {
      const result = await setConfig(
        "local",
        "compression.headroom_config",
        '{"protect_recent":6}',
        opts(),
      );
      expect(result.value).toEqual({ protect_recent: 6 });
      expect(result.effective.value).toEqual({ protect_recent: 6 });
      expect(result.effective.layer).toBe("local");
      // Structural compare: a reference compare called every object write "overridden".
      expect(result.overriddenBy).toBeUndefined();
    });

    it("replaces the whole object rather than merging", async () => {
      await setConfig("local", "compression.headroom_config", '{"protect_recent":6}', opts());
      const result = await setConfig(
        "local",
        "compression.headroom_config",
        '{"target_ratio":0.5}',
        opts(),
      );
      expect(result.effective.value).toEqual({ target_ratio: 0.5 });
    });
  });

  describe("unsetConfig", () => {
    it("removes the key and falls back to a lower layer", async () => {
      await writeSetting("project", "compression.level", "2", { projectDir });
      const result = await unsetConfig("project", "compression.level", opts());
      expect(result.effective.value).toBe("1");
      expect(result.effective.layer).toBe("default");
    });
  });

  describe("renderers", () => {
    it("renderConfigList prints keys and layers", () => {
      const out = renderConfigList({
        entries: [{ key: "compression.level", value: "2", layer: "project", source: "/x" }],
      });
      expect(out).toContain('compression.level = "2" — project (/x)');
    });

    it("renderConfigGet prints one key", () => {
      const out = renderConfigGet({ key: "compression.level", value: "1", layer: "default" });
      expect(out).toContain('compression.level = "1" — default');
    });

    it("renderConfigSet prints the file and effective value", () => {
      const out = renderConfigSet({
        key: "compression.level",
        value: "2",
        scope: "project",
        file: "/project/.golem/settings.json",
        effective: { key: "compression.level", value: "2", layer: "project" },
      });
      expect(out).toContain('compression.level set to "2" in /project/.golem/settings.json');
    });

    it("renderConfigUnset prints the fallback", () => {
      const out = renderConfigUnset({
        key: "compression.level",
        scope: "project",
        file: "/project/.golem/settings.json",
        effective: { key: "compression.level", value: "1", layer: "default" },
      });
      expect(out).toContain("compression.level removed from project scope");
      expect(out).toContain('effective value: "1" — default');
    });
  });
});
