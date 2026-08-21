/**
 * Decision 53 — spawn-free detection for the managed-tool registry.
 *
 * The Windows half is the point of these tests: an npm-installed CLI is a
 * `.cmd` shim there, so a detector that only looks for a bare filename reports
 * "not installed" for a tool that is plainly on PATH.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commandOnPath, moduleOnDisk, pluginOnDisk } from "../../../src/pkg/detect.js";
import { rmTemp } from "../../helpers/tmp.js";

describe("commandOnPath", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-ext-detect-"));
  });

  afterEach(async () => {
    await rm(dir, rmTemp);
  });

  it("finds a bare executable on PATH", async () => {
    await writeFile(path.join(dir, "toolx"), "#!/bin/sh\n");
    expect(commandOnPath("toolx", { PATH: dir })).toBe(path.join(dir, "toolx"));
  });

  it("returns null when the name is not on PATH", () => {
    expect(commandOnPath("definitely-not-a-real-tool-xyz", { PATH: dir })).toBeNull();
  });

  it("searches every PATH entry, in order", async () => {
    const second = await mkdtemp(path.join(tmpdir(), "golem-ext-detect2-"));
    try {
      await writeFile(path.join(second, "tooly"), "");
      const combined = [dir, second].join(path.delimiter);
      expect(commandOnPath("tooly", { PATH: combined })).toBe(path.join(second, "tooly"));
    } finally {
      await rm(second, rmTemp);
    }
  });

  it("ignores directories that do not exist", async () => {
    await writeFile(path.join(dir, "toolz"), "");
    const withGhost = [path.join(dir, "nope"), dir].join(path.delimiter);
    expect(commandOnPath("toolz", { PATH: withGhost })).toBe(path.join(dir, "toolz"));
  });

  it("treats a path-like name as a direct check, not a PATH lookup", async () => {
    const direct = path.join(dir, "direct-tool");
    await writeFile(direct, "");
    // No PATH at all: an explicit path must still resolve.
    expect(commandOnPath(direct, { PATH: "" })).toBe(path.resolve(direct));
    expect(commandOnPath(path.join(dir, "missing-tool"), { PATH: "" })).toBeNull();
  });

  it("does not match a directory that shares the name", async () => {
    const asDir = await mkdtemp(path.join(tmpdir(), "golem-ext-dirname-"));
    try {
      expect(commandOnPath(path.basename(asDir), { PATH: path.dirname(asDir) })).toBeNull();
    } finally {
      await rm(asDir, rmTemp);
    }
  });

  it("accepts an empty/absent PATH without throwing", () => {
    expect(commandOnPath("anything", {})).toBeNull();
    expect(commandOnPath("anything", { PATH: "" })).toBeNull();
  });

  it.runIf(process.platform === "win32")("honours PATHEXT on Windows", async () => {
    await writeFile(path.join(dir, "shimtool.CMD"), "@echo off\n");
    // The bare name does not exist — only the .CMD shim does, which is exactly
    // how an npm-installed CLI looks on Windows.
    expect(commandOnPath("shimtool", { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" })).toBe(
      path.join(dir, "shimtool.CMD"),
    );
  });

  it.runIf(process.platform === "win32")(
    "falls back to a default PATHEXT when the variable is unset",
    async () => {
      await writeFile(path.join(dir, "exetool.EXE"), "");
      expect(commandOnPath("exetool", { PATH: dir })).toBe(path.join(dir, "exetool.EXE"));
    },
  );

  it.runIf(process.platform !== "win32")("does not invent extensions off Windows", async () => {
    await writeFile(path.join(dir, "posixtool.exe"), "");
    expect(commandOnPath("posixtool", { PATH: dir })).toBeNull();
  });
});

describe("moduleOnDisk", () => {
  it("resolves a dependency that is installed", () => {
    // zod is a hard runtime dependency, so this must hold in every checkout.
    expect(moduleOnDisk("zod")).not.toBeNull();
  });

  it("returns null for a module that is not installed", () => {
    expect(moduleOnDisk("@golem/definitely-not-installed")).toBeNull();
  });

  it("does not throw on a malformed specifier", () => {
    expect(moduleOnDisk("")).toBeNull();
  });
});

/**
 * R8.14 — `installed_plugins.json` is the authority for plugin presence, not the
 * content cache. `claude plugin uninstall` empties the registry but leaves the
 * cache behind (verification-notes §133), and the old cache-only check therefore
 * reported an uninstalled plugin as present.
 */
describe("pluginOnDisk", () => {
  let home = "";

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "golem-plugins-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const env = (): Record<string, string | undefined> => ({ HOME: home });

  async function writeRegistry(body: string): Promise<void> {
    await mkdir(path.join(home, ".claude", "plugins"), { recursive: true });
    await writeFile(path.join(home, ".claude", "plugins", "installed_plugins.json"), body, "utf8");
  }

  async function makeCache(marketplace: string, name: string): Promise<string> {
    const dir = path.join(home, ".claude", "plugins", "cache", marketplace, name, "abc123");
    await mkdir(dir, { recursive: true });
    return path.dirname(dir);
  }

  it("reports absent when the registry says nothing is installed, cache or not", async () => {
    await makeCache("caveman", "caveman");
    await writeRegistry(JSON.stringify({ version: 2, plugins: {} }));
    expect(pluginOnDisk("caveman", "caveman", env())).toBeNull();
  });

  it("reports present when the registry lists the plugin", async () => {
    const cache = await makeCache("caveman", "caveman");
    await writeRegistry(JSON.stringify({ version: 2, plugins: { "caveman@caveman": {} } }));
    expect(pluginOnDisk("caveman", "caveman", env())).toBe(cache);
  });

  it("accepts a bare id with no marketplace suffix", async () => {
    await writeRegistry(JSON.stringify({ version: 2, plugins: { caveman: {} } }));
    // No cache directory: the record itself is the evidence.
    expect(pluginOnDisk("caveman", "caveman", env())).toBe(
      path.join(home, ".claude", "plugins", "installed_plugins.json"),
    );
  });

  it("does not match a different marketplace's plugin of the same name", async () => {
    await makeCache("caveman", "caveman");
    await writeRegistry(JSON.stringify({ version: 2, plugins: { "caveman@somewhere-else": {} } }));
    expect(pluginOnDisk("caveman", "caveman", env())).toBeNull();
  });

  it("falls back to the cache when there is no registry file at all", async () => {
    const cache = await makeCache("caveman", "caveman");
    expect(pluginOnDisk("caveman", "caveman", env())).toBe(cache);
  });

  it("falls back to the cache when the registry is unparseable", async () => {
    const cache = await makeCache("caveman", "caveman");
    await writeRegistry("{ not json");
    expect(pluginOnDisk("caveman", "caveman", env())).toBe(cache);
  });

  it("reports absent when neither the registry nor a cache exists", async () => {
    expect(pluginOnDisk("caveman", "caveman", env())).toBeNull();
  });
});
