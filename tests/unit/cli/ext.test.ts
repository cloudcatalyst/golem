/**
 * Decision 53 — `golem ext` rendering.
 *
 * The assertions that matter are the honest ones: the gate note must survive to
 * the output for an enabled-but-gated tool, and the footer must refuse to claim
 * liveness. Those two lines are the whole reason this surface exists.
 */

import { describe, expect, it } from "vitest";
import { renderPkg } from "../../../src/cli/pkg.js";
import type { GolemSettings } from "../../../src/config/schema.js";
import type { PkgManifest, PkgProbes } from "../../../src/pkg/index.js";
import { resolvePkgStatuses } from "../../../src/pkg/index.js";

const GATED: PkgManifest = {
  id: "gated-tool",
  title: "Gated Tool",
  what: "does gated work",
  tier: "tier-2",
  shape: "callable",
  upstream: "https://example.invalid/gated",
  licence: "MIT",
  pin: "gated==1.2.3",
  detect: { kind: "command", command: "gated-tool" },
  install: "install gated-tool",
  enabledBy: "compression.headroom_sidecar",
  adapter: "src/pkg/manifest.ts",
  degrade: "the gated stage is skipped",
  gate: "Enabled does NOT mean running — it is spawned lazily and further gated.",
};

const PEER: PkgManifest = {
  id: "peer-tool",
  title: "Peer Tool",
  what: "acts on the same surface",
  tier: "tier-3a",
  shape: "peer",
  upstream: "https://example.invalid/peer",
  licence: "Apache-2.0",
  detect: { kind: "command", command: "peer-tool" },
  install: "install peer-tool yourself",
  degrade: "Golem's own handling stays in effect",
};

function report(probes: PkgProbes, settingValue: unknown) {
  return {
    projectDir: "/tmp/project",
    rows: resolvePkgStatuses({
      manifests: [GATED, PEER],
      probes,
      settings: { compression: { headroom_sidecar: settingValue } } as unknown as GolemSettings,
    }),
  };
}

const ALL: PkgProbes = { command: (n) => `/usr/bin/${n}`, module: () => null, plugin: () => null };
const NONE: PkgProbes = { command: () => null, module: () => null, plugin: () => null };

describe("renderPkg", () => {
  it("groups rows under their tier heading", () => {
    const out = renderPkg(report(ALL, true));
    expect(out).toContain("Tier 2 —");
    expect(out).toContain("Tier 3a —");
    expect(out).not.toContain("Tier 3b —"); // no such row in the fixture
  });

  it("shows the gate note for an enabled-but-gated tool", () => {
    const out = renderPkg(report(ALL, true));
    expect(out).toContain("[on]");
    expect(out).toContain("note: Enabled does NOT mean running");
  });

  it("shows the degrade text instead of the gate note when not installed", () => {
    const out = renderPkg(report(NONE, true));
    expect(out).toContain("[not found]");
    expect(out).toContain("without it: the gated stage is skipped");
    expect(out).not.toContain("note: Enabled does NOT mean running");
  });

  it("renders the pin and the gating setting with its value", () => {
    const out = renderPkg(report(ALL, true));
    expect(out).toContain("pin gated==1.2.3");
    expect(out).toContain("compression.headroom_sidecar = true");
  });

  it("refuses to claim liveness in the footer", () => {
    const out = renderPkg(report(ALL, true));
    expect(out).toContain("not liveness");
  });

  it("counts known / enabled / missing tools", () => {
    expect(renderPkg(report(ALL, true))).toContain(
      "2 packages known · 1 enabled · 0 not installed",
    );
    expect(renderPkg(report(NONE, true))).toContain(
      "2 packages known · 0 enabled · 2 not installed",
    );
  });

  it("adds purpose, install, upstream and adapter only in verbose mode", () => {
    const plain = renderPkg(report(ALL, true));
    const verbose = renderPkg(report(ALL, true), true);
    expect(plain).not.toContain("install: install gated-tool");
    expect(verbose).toContain("what: does gated work");
    expect(verbose).toContain("install: install gated-tool");
    expect(verbose).toContain("upstream: https://example.invalid/gated (MIT)");
    expect(verbose).toContain("adapter: src/pkg/manifest.ts");
  });

  it("wraps long detail text without double-indenting continuations", () => {
    const out = renderPkg(report(ALL, true));
    const noteLines = out.split("\n").filter((l) => l.trim().startsWith("note:"));
    expect(noteLines.length).toBe(1);
    // Continuation lines sit in the detail column (14 spaces), not 28.
    for (const line of out.split("\n")) {
      expect(line.startsWith(" ".repeat(28))).toBe(false);
    }
  });

  it("keeps every line within a readable width", () => {
    const out = renderPkg(report(ALL, true), true);
    for (const line of out.split("\n")) {
      // Resolved paths and long URLs are printed verbatim on their own line, so
      // only wrapped prose is width-checked.
      if (line.includes("http") || line.includes("/usr/bin")) continue;
      expect(line.length).toBeLessThanOrEqual(96);
    }
  });
});
