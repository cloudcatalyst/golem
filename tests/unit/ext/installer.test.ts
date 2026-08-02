/**
 * R8.14 — installer resolution and action command logic.
 *
 * These tests cover the pure logic: platform matching, the noop fallback,
 * and the install/upgrade/remove command resolution. The actual spawn is tested
 * via the CLI integration tests (with a stubbed runner) — this is about the
 * decision table.
 */

import { describe, expect, it } from "vitest";
import { EXT_MANIFESTS, resolveActionCommand, resolveInstaller } from "../../../src/ext/index.js";

function find(id: string) {
  const m = EXT_MANIFESTS.find((x) => x.id === id);
  if (m === undefined) throw new Error(`fixture ${id} not in EXT_MANIFESTS`);
  return m;
}

const HEADROOM = find("headroom");
const OLLAMA = find("ollama");
const UNPDF = find("unpdf");
const RTK = find("rtk");
const BREVITY = find("brevity-profiles");

describe("resolveInstaller", () => {
  it("returns null for bundled tools (no installer entries)", () => {
    expect(BREVITY.installer).toBeUndefined();
    expect(resolveInstaller(BREVITY, "linux")).toBeNull();
  });

  it("returns an entry for headroom on any platform (uv is cross-platform)", () => {
    expect(resolveInstaller(HEADROOM, "win32")).not.toBeNull();
    expect(resolveInstaller(HEADROOM, "darwin")).not.toBeNull();
    expect(resolveInstaller(HEADROOM, "linux")).not.toBeNull();
  });

  it("finds the exact-platform entry for ollama on win32", () => {
    const entry = resolveInstaller(OLLAMA, "win32");
    expect(entry).not.toBeNull();
    expect(entry?.kind).toBe("winget");
    expect(entry?.command[0]).toBe("winget");
  });

  it("finds the exact-platform entry for ollama on darwin", () => {
    const entry = resolveInstaller(OLLAMA, "darwin");
    expect(entry).not.toBeNull();
    expect(entry?.kind).toBe("brew");
    expect(entry?.command[0]).toBe("brew");
  });

  it("finds the posix entry for ollama on linux", () => {
    const entry = resolveInstaller(OLLAMA, "linux");
    expect(entry).not.toBeNull();
    expect(entry?.platform).toBe("linux");
  });

  it("falls through to posix for a tool that only declares posix", () => {
    // RTK only has a darwin brew entry; on linux/win32 it should be null.
    expect(resolveInstaller(RTK, "linux")).toBeNull();
    expect(resolveInstaller(RTK, "win32")).toBeNull();
    // On darwin it finds the brew entry.
    const darwinEntry = resolveInstaller(RTK, "darwin");
    expect(darwinEntry).not.toBeNull();
    expect(darwinEntry?.kind).toBe("brew");
  });
});

describe("resolveActionCommand", () => {
  const headroomEntry = resolveInstaller(HEADROOM, "linux");

  it("install uses the entry's command", () => {
    expect(headroomEntry).not.toBeNull();
    if (headroomEntry === null) return;
    const cmd = resolveActionCommand(headroomEntry, "install");
    expect(cmd).toEqual([
      "uv",
      "run",
      "--with",
      "headroom-ai==0.30.0",
      "headroom-compress",
      "--help",
    ]);
  });

  it("upgrade uses the entry's upgrade when present", () => {
    expect(headroomEntry).not.toBeNull();
    if (headroomEntry === null) return;
    const cmd = resolveActionCommand(headroomEntry, "upgrade");
    expect(cmd).toEqual([
      "uv",
      "run",
      "--with",
      "headroom-ai==0.30.0",
      "headroom-compress",
      "--version",
    ]);
  });

  it("remove returns null when no remove command is registered", () => {
    expect(headroomEntry).not.toBeNull();
    if (headroomEntry === null) return;
    const cmd = resolveActionCommand(headroomEntry, "remove");
    expect(cmd).toBeNull();
  });

  it("upgrade falls back to install command when no upgrade is present", () => {
    const entry = resolveInstaller(UNPDF, "linux");
    expect(entry).not.toBeNull();
    if (entry === null) return;
    expect(entry.upgrade).toBeUndefined();
    const cmd = resolveActionCommand(entry, "upgrade");
    expect(cmd).toEqual(["npm", "install", "unpdf@1.6.2"]);
  });
});

describe("installer invariants", () => {
  it("every installer command is an argument array (binary is first, no shell chaining)", () => {
    for (const manifest of EXT_MANIFESTS) {
      if (manifest.installer === undefined) continue;
      for (const entry of manifest.installer) {
        expect(entry.command.length).toBeGreaterThan(0);
        // The first element is a binary name — no shell metacharacters.
        expect(entry.command[0]).not.toMatch(/[;&|>`$\s]/);
        if (entry.upgrade !== undefined) {
          expect(entry.upgrade.length).toBeGreaterThan(0);
          expect(entry.upgrade[0]).not.toMatch(/[;&|>`$\s]/);
        }
        if (entry.remove !== undefined) {
          expect(entry.remove.length).toBeGreaterThan(0);
          expect(entry.remove[0]).not.toMatch(/[;&|>`$\s]/);
        }
      }
    }
  });
});
