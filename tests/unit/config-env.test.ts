/** E1: GOLEM_<SECTION>_<KEY> env mapping — names, case, coercion, warnings. */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, readEnvLayer } from "../../src/config/index.js";

let base: string;
let userDir: string;
let projectDir: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "golem-env-test-"));
  userDir = path.join(base, "user-golem");
  projectDir = path.join(base, "project");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const load = (env: Record<string, string | undefined>) => loadConfig({ projectDir, userDir, env });

describe("env override mapping", () => {
  it("maps multi-underscore keys after the first section token", async () => {
    const config = await load({
      GOLEM_PROXY_UPSTREAM_BASE_URL: "https://gateway.example.com",
      GOLEM_PROXY_REQUEST_TIMEOUT_MS: "120000",
    });
    expect(config.settings.proxy.upstream_base_url).toBe("https://gateway.example.com");
    expect(config.settings.proxy.request_timeout_ms).toBe(120000);
    expect(config.provenance["proxy.upstream_base_url"]).toEqual({
      layer: "env",
      source: "GOLEM_PROXY_UPSTREAM_BASE_URL",
    });
  });

  it("matches names case-insensitively (Windows-style input)", async () => {
    const config = await load({ golem_Proxy_Port: "9999" });
    expect(config.settings.proxy.port).toBe(9999);
    expect(config.provenance["proxy.port"]).toEqual({
      layer: "env",
      source: "golem_Proxy_Port",
    });
  });

  it("rejects case-colliding names with different values", () => {
    expect(() => readEnvLayer({ GOLEM_SLIDER_LEVEL: "2", golem_slider_level: "3" })).toThrow(
      ConfigError,
    );
    expect(() => readEnvLayer({ GOLEM_SLIDER_LEVEL: "2", golem_slider_level: "3" })).toThrow(
      /ambiguous/i,
    );
    // Identical values are tolerated.
    const layer = readEnvLayer({ GOLEM_SLIDER_LEVEL: "2", golem_slider_level: "2" });
    expect(layer.overrides).toHaveLength(1);
  });

  it("coerces booleans from the documented token set", async () => {
    for (const [raw, expected] of [
      ["true", true],
      ["1", true],
      ["YES", true],
      ["on", true],
      ["false", false],
      ["0", false],
      ["No", false],
      ["OFF", false],
    ] as const) {
      const config = await load({ GOLEM_TELEMETRY_ENABLED: raw });
      expect(config.settings.telemetry.enabled).toBe(expected);
    }
    await expect(load({ GOLEM_TELEMETRY_ENABLED: "maybe" })).rejects.toThrow(
      /GOLEM_TELEMETRY_ENABLED.*boolean/,
    );
  });

  it("coerces arrays from JSON or comma-separated form", async () => {
    const json = await load({ GOLEM_KNOWLEDGE_WATCH_PATHS: '["docs", "src/lib"]' });
    expect(json.settings.knowledge.watch_paths).toEqual(["docs", "src/lib"]);
    const csv = await load({ GOLEM_KNOWLEDGE_WATCH_PATHS: "docs, src/lib ,notes" });
    expect(csv.settings.knowledge.watch_paths).toEqual(["docs", "src/lib", "notes"]);
    await expect(load({ GOLEM_KNOWLEDGE_WATCH_PATHS: "[not json" })).rejects.toThrow(
      /GOLEM_KNOWLEDGE_WATCH_PATHS/,
    );
  });

  it("overrides knowledge.wiki_dir as a plain string (verbatim, not trimmed)", async () => {
    const config = await load({ GOLEM_KNOWLEDGE_WIKI_DIR: "notes/wiki" });
    expect(config.settings.knowledge.wiki_dir).toBe("notes/wiki");
    expect(config.provenance["knowledge.wiki_dir"]).toEqual({
      layer: "env",
      source: "GOLEM_KNOWLEDGE_WIKI_DIR",
    });
  });

  it("rejects non-numeric values for numeric keys, naming the variable", async () => {
    await expect(load({ GOLEM_PROXY_PORT: "eighty" })).rejects.toThrow(/GOLEM_PROXY_PORT.*number/);
  });

  it("rejects schema-invalid values, naming variable and key", async () => {
    const err = await load({ GOLEM_SLIDER_LEVEL: "9" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toContain("GOLEM_SLIDER_LEVEL");
    expect((err as ConfigError).key).toBe("slider.level");
  });

  it("warns on unrecognized GOLEM_* variables instead of failing", async () => {
    const config = await load({ GOLEM_NOPE_KEY: "x", GOLEM_SLIDER_LEVEL: "2" });
    expect(config.settings.slider.level).toBe(2);
    expect(config.warnings.some((w) => w.includes("GOLEM_NOPE_KEY"))).toBe(true);
  });

  it("ignores empty-string values and non-GOLEM variables", async () => {
    const config = await load({
      GOLEM_SLIDER_LEVEL: "",
      PATH: "C:\\Windows",
      HOME: "/home/user",
    });
    expect(config.settings.slider.level).toBe(1); // default
    expect(config.warnings).toEqual([]);
  });
});
