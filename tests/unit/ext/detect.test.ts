/**
 * Decision 53 — spawn-free detection for the managed-tool registry.
 *
 * The Windows half is the point of these tests: an npm-installed CLI is a
 * `.cmd` shim there, so a detector that only looks for a bare filename reports
 * "not installed" for a tool that is plainly on PATH.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commandOnPath, moduleOnDisk } from "../../../src/pkg/detect.js";
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
