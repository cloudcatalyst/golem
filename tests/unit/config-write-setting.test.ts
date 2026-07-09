/** E1: writeSetting — round-trips, unknown-key preservation, formatting, safety. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, writeSetting } from "../../src/config/index.js";

let base: string;
let userDir: string;
let projectDir: string;

const userFile = (): string => path.join(userDir, "settings.json");
const projectFile = (): string => path.join(projectDir, ".golem", "settings.json");
const localFile = (): string => path.join(projectDir, ".golem", "settings.local.json");

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "golem-write-test-"));
  userDir = path.join(base, "user-golem");
  projectDir = path.join(base, "project");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const dirs = () => ({ projectDir, userDir });

describe("writeSetting", () => {
  it("creates directories and file on first write, per scope", async () => {
    expect(await writeSetting("user", "slider.level", 3, dirs())).toBe(userFile());
    expect(await writeSetting("project", "proxy.port", 5001, dirs())).toBe(projectFile());
    expect(await writeSetting("local", "telemetry.enabled", false, dirs())).toBe(localFile());

    const config = await loadConfig({ projectDir, userDir, env: {} });
    expect(config.settings.slider.level).toBe(3);
    expect(config.settings.proxy.port).toBe(5001);
    expect(config.settings.telemetry.enabled).toBe(false);
    expect(config.provenance["slider.level"]?.layer).toBe("user");
    expect(config.provenance["proxy.port"]?.layer).toBe("project");
    expect(config.provenance["telemetry.enabled"]?.layer).toBe("local");
  });

  it("round-trips preserving unknown keys, key order, indent, and trailing newline", async () => {
    const original = {
      x_custom: { note: "keep me" },
      slider: { level: 2, future_flag: true },
      proxy: { port: 4000 },
    };
    await mkdir(path.dirname(localFile()), { recursive: true });
    await writeFile(localFile(), `${JSON.stringify(original, null, 4)}\n`, "utf8");

    await writeSetting("local", "slider.level", 5, dirs());

    const text = await readFile(localFile(), "utf8");
    const parsed = JSON.parse(text) as typeof original;
    expect(parsed.x_custom).toEqual({ note: "keep me" });
    expect(parsed.slider.future_flag).toBe(true);
    expect(parsed.slider.level).toBe(5);
    expect(parsed.proxy.port).toBe(4000);
    // Key order preserved (x_custom still first), 4-space indent, trailing \n.
    expect(Object.keys(parsed)[0]).toBe("x_custom");
    expect(text).toContain('\n    "slider"');
    expect(text.endsWith("\n")).toBe(true);

    // The written file still loads (unknown keys warn, don't fail).
    const config = await loadConfig({ projectDir, userDir, env: {} });
    expect(config.settings.slider.level).toBe(5);
    expect(config.warnings.length).toBeGreaterThan(0);
  });

  it("rejects unknown keys and invalid values without touching the file", async () => {
    await expect(writeSetting("user", "nope.key", 1, dirs())).rejects.toThrow(
      /unknown setting "nope\.key"/,
    );
    await expect(writeSetting("user", "slider", 1, dirs())).rejects.toThrow(ConfigError);
    await expect(writeSetting("user", "slider.level", 99, dirs())).rejects.toThrow(
      /invalid value for "slider\.level"/,
    );
    await expect(
      writeSetting("user", "proxy.upstream_base_url", "not a url", dirs()),
    ).rejects.toThrow(/proxy\.upstream_base_url/);
    // No file was created by the failed writes.
    await expect(readFile(userFile(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a key when value is undefined", async () => {
    await writeSetting("project", "slider.level", 4, dirs());
    await writeSetting("project", "slider.local_only_opt_in", true, dirs());
    await writeSetting("project", "slider.level", undefined, dirs());

    const parsed = JSON.parse(await readFile(projectFile(), "utf8")) as {
      slider: Record<string, unknown>;
    };
    expect(parsed.slider).toEqual({ local_only_opt_in: true });
    const config = await loadConfig({ projectDir, userDir, env: {} });
    expect(config.settings.slider.level).toBe(1); // back to default
    expect(config.provenance["slider.level"]).toEqual({ layer: "default" });
  });

  it("refuses to overwrite a malformed settings file", async () => {
    await mkdir(path.dirname(userFile()), { recursive: true });
    await writeFile(userFile(), "{ broken", "utf8");
    await expect(writeSetting("user", "slider.level", 2, dirs())).rejects.toThrow(/invalid JSON/);
    expect(await readFile(userFile(), "utf8")).toBe("{ broken"); // untouched
  });

  it("accepts array values for array leaves", async () => {
    await writeSetting("project", "knowledge.watch_paths", ["docs", "src"], dirs());
    const config = await loadConfig({ projectDir, userDir, env: {} });
    expect(config.settings.knowledge.watch_paths).toEqual(["docs", "src"]);
  });

  it("refuses to overwrite a section that is not an object", async () => {
    await mkdir(path.dirname(userFile()), { recursive: true });
    await writeFile(userFile(), JSON.stringify({ slider: "not-an-object" }), "utf8");

    await expect(writeSetting("user", "slider.level", 3, dirs())).rejects.toThrow(
      /section "slider" is not an object; refusing to overwrite it/,
    );
    // File untouched.
    const text = await readFile(userFile(), "utf8");
    expect(JSON.parse(text)).toEqual({ slider: "not-an-object" });
  });

  it("strips a leading UTF-8 BOM before parsing an existing file", async () => {
    await mkdir(path.dirname(userFile()), { recursive: true });
    const original = { slider: { level: 2 } };
    await writeFile(userFile(), `﻿${JSON.stringify(original, null, 2)}\n`, "utf8");

    await writeSetting("user", "slider.level", 4, dirs());

    const text = await readFile(userFile(), "utf8");
    // BOM is not preserved in the rewritten file; content parses and is correct.
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    const parsed = JSON.parse(text) as typeof original;
    expect(parsed.slider.level).toBe(4);
  });
});
