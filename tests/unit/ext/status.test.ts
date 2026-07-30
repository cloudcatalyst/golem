/**
 * Decision 53 — every registry state is reachable without installing anything,
 * because detection is injected.
 *
 * The state that matters most is `enabled` + a `gate` note: that combination is
 * the one that previously required grepping the process table to understand
 * (Headroom is switched on in this repo and has never run).
 */

import { describe, expect, it } from "vitest";
import type { GolemSettings } from "../../../src/config/schema.js";
import type { ExtManifest, ExtProbes } from "../../../src/ext/index.js";
import { resolveExtStatuses } from "../../../src/ext/index.js";

const NOTHING: ExtProbes = { command: () => null, module: () => null };
const EVERYTHING: ExtProbes = {
  command: (name) => `/usr/bin/${name}`,
  module: (spec) => `/node_modules/${spec}`,
};

function settings(tree: Record<string, Record<string, unknown>>): GolemSettings {
  return tree as unknown as GolemSettings;
}

const CALLABLE: ExtManifest = {
  id: "thing",
  title: "Thing",
  what: "does a thing",
  tier: "tier-2",
  shape: "callable",
  upstream: "https://example.invalid/thing",
  licence: "MIT",
  detect: { kind: "command", command: "thing" },
  install: "install thing",
  enabledBy: "compression.headroom_sidecar",
  degrade: "nothing happens",
};

const NEEDS_LAUNCHER: ExtManifest = {
  ...CALLABLE,
  id: "needy",
  detect: { kind: "command", command: "needy" },
  requires: ["launcher"],
};

const LAUNCHER: ExtManifest = {
  id: "launcher",
  title: "Launcher",
  what: "launches",
  tier: "tier-2",
  shape: "callable",
  upstream: "https://example.invalid/launcher",
  licence: "MIT",
  detect: { kind: "command", command: "launcher" },
  install: "install launcher",
  degrade: "nothing launches",
};

const BUNDLED: ExtManifest = {
  id: "bundled-thing",
  title: "Bundled",
  what: "our own data",
  tier: "tier-3b",
  shape: "in-process",
  upstream: "https://example.invalid/source",
  licence: "MIT (attribution)",
  detect: { kind: "bundled" },
  install: "built in",
  degrade: "n/a",
};

describe("resolveExtStatuses", () => {
  it("reports not-installed when detection fails, and keeps the degrade text", () => {
    const [row] = resolveExtStatuses({ manifests: [CALLABLE], probes: NOTHING });
    expect(row?.state).toBe("not-installed");
    expect(row?.installed).toBe(false);
    expect(row?.where).toBeNull();
    expect(row?.manifest.degrade).toBe("nothing happens");
  });

  it("reports enabled when present and the setting is true", () => {
    const [row] = resolveExtStatuses({
      manifests: [CALLABLE],
      probes: EVERYTHING,
      settings: settings({ compression: { headroom_sidecar: true } }),
    });
    expect(row?.state).toBe("enabled");
    expect(row?.enabled).toBe(true);
    expect(row?.settingValue).toBe("true");
    expect(row?.where).toBe("/usr/bin/thing");
  });

  it("reports disabled when present and the setting is false", () => {
    const [row] = resolveExtStatuses({
      manifests: [CALLABLE],
      probes: EVERYTHING,
      settings: settings({ compression: { headroom_sidecar: false } }),
    });
    expect(row?.state).toBe("disabled");
    expect(row?.enabled).toBe(false);
  });

  it("reports present (not enabled/disabled) when the row has no on/off setting", () => {
    const [row] = resolveExtStatuses({ manifests: [LAUNCHER], probes: EVERYTHING });
    expect(row?.state).toBe("present");
    expect(row?.enabled).toBeNull();
    expect(row?.settingValue).toBeNull();
  });

  it("reports blocked when a required row is missing, even if it is itself installed", () => {
    const probes: ExtProbes = {
      command: (name) => (name === "launcher" ? null : `/usr/bin/${name}`),
      module: () => null,
    };
    const rows = resolveExtStatuses({
      manifests: [LAUNCHER, NEEDS_LAUNCHER],
      probes,
      settings: settings({ compression: { headroom_sidecar: true } }),
    });
    const needy = rows.find((r) => r.id === "needy");
    expect(needy?.installed).toBe(true);
    expect(needy?.state).toBe("blocked");
    expect(needy?.missingRequirements).toEqual(["launcher"]);
  });

  it("clears missingRequirements once the requirement is present", () => {
    const rows = resolveExtStatuses({
      manifests: [LAUNCHER, NEEDS_LAUNCHER],
      probes: EVERYTHING,
      settings: settings({ compression: { headroom_sidecar: true } }),
    });
    expect(rows.find((r) => r.id === "needy")?.state).toBe("enabled");
    expect(rows.find((r) => r.id === "needy")?.missingRequirements).toEqual([]);
  });

  it("treats bundled rows as always present and never installable", () => {
    const [row] = resolveExtStatuses({ manifests: [BUNDLED], probes: NOTHING });
    expect(row?.state).toBe("bundled");
    expect(row?.installed).toBe(true);
  });

  it("reports enabled = null when no settings are supplied", () => {
    const [row] = resolveExtStatuses({ manifests: [CALLABLE], probes: EVERYTHING });
    expect(row?.enabled).toBeNull();
    expect(row?.state).toBe("present");
  });

  describe("setting interpretation", () => {
    const withValue = (value: unknown) =>
      resolveExtStatuses({
        manifests: [{ ...CALLABLE, enabledBy: "brevity.level" }],
        probes: EVERYTHING,
        settings: settings({ brevity: { level: value } }),
      })[0];

    it('reads the string "off" as disabled', () => {
      expect(withValue("off")?.state).toBe("disabled");
    });

    it("reads a non-off string as enabled", () => {
      expect(withValue("full")?.state).toBe("enabled");
      expect(withValue("full")?.settingValue).toBe("full");
    });

    it("reads an empty string as disabled", () => {
      expect(withValue("")?.state).toBe("disabled");
    });

    it("reads a positive number as enabled and zero as disabled", () => {
      expect(withValue(3)?.state).toBe("enabled");
      expect(withValue(0)?.state).toBe("disabled");
    });

    it("reads a missing key as enabled = null", () => {
      const row = resolveExtStatuses({
        manifests: [{ ...CALLABLE, enabledBy: "brevity.level" }],
        probes: EVERYTHING,
        settings: settings({ brevity: {} }),
      })[0];
      expect(row?.enabled).toBeNull();
      expect(row?.settingValue).toBeNull();
    });
  });
});
