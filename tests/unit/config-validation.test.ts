/** E1: invalid config fails with path-specific messages; unknown keys warn. */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/index.js";
import { useTempDirs } from "../helpers/tmp.js";

let base: string;
let userDir: string;
let projectDir: string;

const projectFile = (): string => path.join(projectDir, ".golem", "settings.json");
const localFile = (): string => path.join(projectDir, ".golem", "settings.local.json");

async function writeRaw(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}

const newTempDir = useTempDirs("golem-validate-test-");

beforeEach(async () => {
  base = await newTempDir();
  userDir = path.join(base, "user-golem");
  projectDir = path.join(base, "project");
});

const load = () => loadConfig({ projectDir, userDir, env: {} });

describe("config validation errors", () => {
  it("names the file and the key when a value has the wrong type", async () => {
    await writeRaw(projectFile(), JSON.stringify({ compression: { level: "three" } }));
    const err = await load().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    const configError = err as ConfigError;
    expect(configError.message).toContain(projectFile());
    expect(configError.message).toContain("compression.level");
    expect(configError.source).toBe(projectFile());
    expect(configError.key).toBe("compression.level");
  });

  it("names the file and key for range violations", async () => {
    await writeRaw(localFile(), JSON.stringify({ compression: { level: "7" } }));
    await expect(load()).rejects.toThrow(/settings\.local\.json.*compression\.level/s);
  });

  it("names the file on malformed JSON", async () => {
    await writeRaw(localFile(), "{ not json !");
    const err = await load().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toContain(localFile());
    expect((err as ConfigError).message).toMatch(/invalid JSON/);
  });

  it("rejects non-object roots and non-object sections", async () => {
    await writeRaw(projectFile(), JSON.stringify(["nope"]));
    await expect(load()).rejects.toThrow(/root must be a JSON object/);

    await writeRaw(projectFile(), JSON.stringify({ proxy: 8080 }));
    await expect(load()).rejects.toThrow(/section "proxy" must be an object/);
  });

  it("validates URL-shaped keys", async () => {
    await writeRaw(projectFile(), JSON.stringify({ proxy: { upstream_base_url: "not a url" } }));
    await expect(load()).rejects.toThrow(/proxy\.upstream_base_url/);
  });

  it("warns (does not fail) on unknown sections and keys, and ignores them", async () => {
    await writeRaw(
      projectFile(),
      JSON.stringify({
        compression: { level: "2", future_flag: true },
        third_party: { anything: 1 },
      }),
    );
    const config = await load();
    expect(config.settings.compression.level).toBe("2");
    expect(
      config.warnings.some(
        (w) => w.includes("compression.future_flag") && w.includes(projectFile()),
      ),
    ).toBe(true);
    expect(
      config.warnings.some((w) => w.includes('"third_party"') && w.includes(projectFile())),
    ).toBe(true);
  });

  it("validates per-request overrides like any other layer", async () => {
    await expect(
      loadConfig({
        projectDir,
        userDir,
        env: {},
        overrides: { compression: { level: 42 as never } },
      }),
    ).rejects.toThrow(/per-request overrides.*compression\.level/s);
  });
});
