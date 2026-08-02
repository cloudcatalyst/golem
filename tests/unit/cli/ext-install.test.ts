/**
 * R8.14 — `golem ext install/remove/upgrade` CLI layer.
 *
 * Tests the non-spawning logic: id resolution, machine-installability check,
 * and the action summary. The actual spawn in `runExtAction` is exercised
 * via a stubbed manifest path (no installer for the platform).
 */

import { describe, expect, it } from "vitest";
import { isMachineInstallable, resolveExtForAction, runExtAction } from "../../../src/cli/ext.js";
import { actionSummary, EXT_MANIFESTS, resolveInstaller } from "../../../src/ext/index.js";

function find(id: string) {
  const m = EXT_MANIFESTS.find((x) => x.id === id);
  if (m === undefined) throw new Error(`fixture ${id} not in EXT_MANIFESTS`);
  return m;
}

describe("isMachineInstallable", () => {
  it("returns true for tools with an installer", () => {
    expect(isMachineInstallable("headroom")).toBe(true);
    expect(isMachineInstallable("ollama")).toBe(true);
    expect(isMachineInstallable("unpdf")).toBe(true);
  });

  it("returns false for bundled tools", () => {
    expect(isMachineInstallable("brevity-profiles")).toBe(false);
  });

  it("returns false for tools explicitly not machine-installable", () => {
    expect(isMachineInstallable("caveman")).toBe(false);
  });

  it("returns false for unknown ids", () => {
    expect(isMachineInstallable("no-such-tool")).toBe(false);
  });
});

describe("resolveExtForAction", () => {
  it("resolves a known tool with an installer", () => {
    const result = resolveExtForAction("headroom");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.id).toBe("headroom");
  });

  it("refuses an unknown id", () => {
    const result = resolveExtForAction("no-such-tool");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("unknown managed tool");
  });

  it("refuses a bundled tool with a pointer to the install docs", () => {
    const result = resolveExtForAction("brevity-profiles");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("bundled or a peer");
  });

  it("refuses a peer tool without machine installer", () => {
    const result = resolveExtForAction("caveman");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("bundled or a peer");
  });
});

describe("actionSummary", () => {
  const headroom = find("headroom");

  it("describes install with the pin", () => {
    const entry = resolveInstaller(headroom, "linux");
    expect(entry).not.toBeNull();
    if (entry === null) return;
    const summary = actionSummary(headroom, entry, "install");
    expect(summary).toContain("golem ext install headroom");
    expect(summary).toContain("0.30.0");
  });

  it("reports no installer available for an unsupported platform", () => {
    const rtk = find("rtk");
    // RTK only has a darwin brew entry; on win32 it should be null.
    const entry = resolveInstaller(rtk, "win32");
    expect(entry).toBeNull();
    const summary = actionSummary(rtk, entry, "install", "win32");
    expect(summary).toContain("no installer is available for this platform");
  });
});

describe("runExtAction", () => {
  it("returns done:false when no installer is available for the platform", async () => {
    const brevity = find("brevity-profiles");
    const result = await runExtAction(brevity, "install");
    expect(result.done).toBe(false);
    expect(result.code).toBeNull();
    expect(result.message).toContain("no installer available");
  });
});
