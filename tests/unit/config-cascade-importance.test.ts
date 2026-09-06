/**
 * ADR-0008 — the two-band cascade: any origin may declare `!important`, and
 * importance reverses origin order.
 *
 * The reversal is asserted PER PAIR rather than in aggregate. A single
 * "the strongest one wins" test passes just as happily against a resolver that
 * has the middle of the ladder backwards, and the middle of the ladder is the
 * whole novelty here.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  loadConfig,
  ORIGIN_ORDER,
  writeSetting,
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

const newTempDir = useTempDirs("golem-cascade-test-");

beforeEach(async () => {
  base = await newTempDir();
  userDir = path.join(base, "user-golem");
  projectDir = path.join(base, "project");
  await mkdir(projectDir, { recursive: true });
});

/** `compression.level` is the probe throughout: a string enum with four values. */
const level = (value: string, important = false): Record<string, unknown> => ({
  compression: { level: value },
  ...(important && { "!important": ["compression.level"] }),
});

describe("ORIGIN_ORDER", () => {
  it("is the single ladder both bands read, with `team` between user and project", () => {
    expect([...ORIGIN_ORDER]).toEqual([
      "default",
      "user",
      "team",
      "project",
      "local",
      "env",
      "override",
    ]);
  });
});

describe("the normal band is unchanged", () => {
  it("resolves identically to a pre-importance install when nothing is important", async () => {
    await writeJson(userFile(), { compression: { level: "off" }, proxy: { port: 5000 } });
    await writeJson(projectFile(), { compression: { level: "1" } });
    await writeJson(localFile(), { compression: { level: "2" } });

    const config = await loadConfig({ projectDir, userDir, env: {} });

    expect(config.settings.compression.level).toBe("2");
    expect(config.warnings).toEqual([]);
    // `important` is ABSENT, not false: a provenance entry an existing caller
    // compares with toEqual must not grow a key it did not have.
    expect(config.provenance["compression.level"]).toEqual({
      layer: "local",
      source: localFile(),
    });
    expect(config.provenance["proxy.port"]).toEqual({ layer: "user", source: userFile() });
    expect(config.provenance["telemetry.enabled"]).toEqual({ layer: "default" });
  });

  it("puts a normal team value above user and below project", async () => {
    await writeJson(userFile(), level("off"));
    const teamLayer = { settings: level("1"), source: "acme" };

    const overUser = await loadConfig({ projectDir, userDir, env: {}, teamLayer });
    expect(overUser.settings.compression.level).toBe("1");
    expect(overUser.provenance["compression.level"]).toEqual({ layer: "team", source: "acme" });

    await writeJson(projectFile(), level("2"));
    const underProject = await loadConfig({ projectDir, userDir, env: {}, teamLayer });
    expect(underProject.settings.compression.level).toBe("2");
    expect(underProject.provenance["compression.level"]?.layer).toBe("project");
  });
});

describe("every important declaration beats every normal one", () => {
  it("lets the WEAKEST important origin beat the strongest normal file origin", async () => {
    // `local!` is the weakest importance a file can declare, and `local` is the
    // strongest normal file origin. If reversal is real, `user!` still wins.
    await writeJson(userFile(), level("off", true));
    await writeJson(projectFile(), level("1"));
    await writeJson(localFile(), level("2"));

    const config = await loadConfig({ projectDir, userDir, env: {} });

    expect(config.settings.compression.level).toBe("off");
    expect(config.provenance["compression.level"]).toEqual({
      layer: "user",
      source: userFile(),
      important: true,
    });
  });

  it("leaves normal keys in the same file resolving normally", async () => {
    await writeJson(userFile(), {
      compression: { level: "off" },
      proxy: { port: 5000 },
      "!important": ["compression.level"],
    });
    await writeJson(localFile(), { compression: { level: "2" }, proxy: { port: 6000 } });

    const config = await loadConfig({ projectDir, userDir, env: {} });

    expect(config.settings.compression.level).toBe("off");
    expect(config.settings.proxy.port).toBe(6000);
    expect(config.provenance["proxy.port"]).toEqual({ layer: "local", source: localFile() });
  });
});

describe("importance reverses origin order, pair by pair", () => {
  it("user! beats team!", async () => {
    await writeJson(userFile(), level("off", true));
    const config = await loadConfig({
      projectDir,
      userDir,
      env: {},
      teamLayer: { settings: level("1", true), source: "acme" },
    });
    expect(config.settings.compression.level).toBe("off");
    expect(config.provenance["compression.level"]?.layer).toBe("user");
  });

  it("team! beats project!", async () => {
    await writeJson(projectFile(), level("2", true));
    const config = await loadConfig({
      projectDir,
      userDir,
      env: {},
      teamLayer: { settings: level("1", true), source: "acme" },
    });
    expect(config.settings.compression.level).toBe("1");
    expect(config.provenance["compression.level"]).toEqual({
      layer: "team",
      source: "acme",
      important: true,
    });
  });

  it("project! beats local!", async () => {
    await writeJson(projectFile(), level("1", true));
    await writeJson(localFile(), level("3", true));
    const config = await loadConfig({ projectDir, userDir, env: {} });
    expect(config.settings.compression.level).toBe("1");
    expect(config.provenance["compression.level"]?.layer).toBe("project");
  });

  it("holds across the whole ladder at once", async () => {
    await writeJson(userFile(), level("off", true));
    await writeJson(projectFile(), level("2", true));
    await writeJson(localFile(), level("3", true));
    const config = await loadConfig({
      projectDir,
      userDir,
      env: {},
      teamLayer: { settings: level("1", true), source: "acme" },
    });
    expect(config.settings.compression.level).toBe("off");
  });
});

describe("a file origin's !important beats GOLEM_*", () => {
  // This one reverses a SHIPPED decision — `GOLEM_*` used to be the last word
  // over every file layer — so it gets its own named test rather than riding
  // along on a broader one. ADR-0008 §The env reversal.
  it("lets local! — the weakest file importance — override an env var", async () => {
    await writeJson(localFile(), level("off", true));
    const config = await loadConfig({
      projectDir,
      userDir,
      env: { GOLEM_COMPRESSION_LEVEL: "3" },
    });
    expect(config.settings.compression.level).toBe("off");
    expect(config.provenance["compression.level"]).toEqual({
      layer: "local",
      source: localFile(),
      important: true,
    });
  });

  it("still lets env beat every NORMAL file declaration", async () => {
    await writeJson(localFile(), level("off"));
    const config = await loadConfig({
      projectDir,
      userDir,
      env: { GOLEM_COMPRESSION_LEVEL: "3" },
    });
    expect(config.settings.compression.level).toBe("3");
    expect(config.provenance["compression.level"]).toEqual({
      layer: "env",
      source: "GOLEM_COMPRESSION_LEVEL",
    });
  });

  it("still lets env beat an important declaration for a DIFFERENT key", async () => {
    await writeJson(localFile(), {
      compression: { level: "off" },
      telemetry: { enabled: false },
      "!important": ["telemetry.enabled"],
    });
    const config = await loadConfig({
      projectDir,
      userDir,
      env: { GOLEM_COMPRESSION_LEVEL: "3" },
    });
    expect(config.settings.compression.level).toBe("3");
    expect(config.settings.telemetry.enabled).toBe(false);
  });
});

describe("the !important declaration list itself", () => {
  it("warns — and does not throw — when it names a key the file does not set", async () => {
    await writeJson(userFile(), {
      compression: { level: "2" },
      "!important": ["telemetry.enabled"],
    });

    const config = await loadConfig({ projectDir, userDir, env: {} });

    expect(config.settings.compression.level).toBe("2");
    expect(config.settings.telemetry.enabled).toBe(DEFAULT_SETTINGS.telemetry.enabled);
    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toContain("telemetry.enabled");
    expect(config.warnings[0]).toContain("does not set it");
  });

  it("rejects a malformed list, naming the file", async () => {
    await writeJson(userFile(), { compression: { level: "2" }, "!important": "compression.level" });
    await expect(loadConfig({ projectDir, userDir, env: {} })).rejects.toThrow(
      /"!important" must be an array/,
    );
  });

  it("is not mistaken for an unknown settings section", async () => {
    await writeJson(userFile(), level("2", true));
    const config = await loadConfig({ projectDir, userDir, env: {} });
    expect(config.warnings).toEqual([]);
  });

  it("reports each warning once, not once per band", async () => {
    await writeJson(userFile(), {
      compression: { level: "2" },
      nonsense: { key: 1 },
      "!important": ["compression.level"],
    });
    const config = await loadConfig({ projectDir, userDir, env: {} });
    expect(config.warnings.filter((w) => w.includes("nonsense"))).toHaveLength(1);
  });
});

describe("the declaration survives an ordinary write", () => {
  it("keeps `!important` in the file when `writeSetting` touches another key", async () => {
    // writeSetting preserves unknown keys by design, and `"!important"` is one
    // of them as far as it is concerned. Asserted anyway: if that ever stopped
    // being true, a team's whole enforcement would vanish on the next
    // `golem config set` with no error and no warning.
    await writeJson(userFile(), {
      compression: { level: "off" },
      "!important": ["compression.level"],
    });
    await writeSetting("user", "proxy.port", 5100, { projectDir, userDir });

    const onDisk = JSON.parse(await readFile(userFile(), "utf8")) as Record<string, unknown>;
    expect(onDisk["!important"]).toEqual(["compression.level"]);

    const config = await loadConfig({ projectDir, userDir, env: {} });
    expect(config.settings.proxy.port).toBe(5100);
    expect(config.provenance["compression.level"]?.important).toBe(true);
  });
});

describe("the floor: what a remote origin may never set", () => {
  it("drops a denied key from a remote origin, loudly, and keeps the local value", async () => {
    const config = await loadConfig({
      projectDir,
      userDir,
      env: {},
      teamLayer: { settings: { proxy: { bypass_all: true } }, source: "acme" },
    });

    expect(config.settings.proxy.bypass_all).toBe(DEFAULT_SETTINGS.proxy.bypass_all);
    expect(config.provenance["proxy.bypass_all"]).toEqual({ layer: "default" });
    expect(config.warnings.join("\n")).toContain("REFUSED");
    expect(config.warnings.join("\n")).toContain("proxy.bypass_all");
  });

  it("drops it at IMPORTANT too — importance is a dial, and no dial disables redaction", async () => {
    const config = await loadConfig({
      projectDir,
      userDir,
      env: {},
      teamLayer: {
        settings: { proxy: { bypass_all: true }, "!important": ["proxy.bypass_all"] },
        source: "acme",
      },
    });

    expect(config.settings.proxy.bypass_all).toBe(false);
    expect(config.warnings.join("\n")).toContain("REFUSED");
  });

  it("still lets a LOCAL origin set it — the floor is about remoteness, not the key", async () => {
    await writeJson(localFile(), { proxy: { bypass_all: true } });
    const config = await loadConfig({ projectDir, userDir, env: {} });
    expect(config.settings.proxy.bypass_all).toBe(true);
    expect(config.warnings.join("\n")).not.toContain("REFUSED");
  });

  it("does not let a remote's other keys be lost along with the denied one", async () => {
    const config = await loadConfig({
      projectDir,
      userDir,
      env: {},
      teamLayer: {
        settings: { proxy: { bypass_all: true }, compression: { level: "1" } },
        source: "acme",
      },
    });
    expect(config.settings.proxy.bypass_all).toBe(false);
    expect(config.settings.compression.level).toBe("1");
  });
});
