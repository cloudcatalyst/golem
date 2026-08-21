/**
 * Decision 53 — drift guards over the managed-tool registry.
 *
 * The registry is data that makes claims about the rest of the repo: settings
 * keys that gate a tool, files that quarantine its imports, prerequisite rows.
 * Every one of those can rot silently, so each is asserted here — the same
 * reasoning as the Decision-50 `SETTING_META` sync test.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SETTINGS_LEAVES } from "../../../src/config/schema.js";
import { PKG_MANIFESTS, pkgManifest } from "../../../src/pkg/index.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function exists(relative: string): Promise<boolean> {
  try {
    await stat(path.join(REPO_ROOT, relative));
    return true;
  } catch {
    return false;
  }
}

describe("PKG_MANIFESTS", () => {
  it("is not empty", () => {
    expect(PKG_MANIFESTS.length).toBeGreaterThan(0);
  });

  it("has unique, kebab-case ids", () => {
    const ids = PKG_MANIFESTS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("finds every row by id via pkgManifest", () => {
    for (const manifest of PKG_MANIFESTS) {
      expect(pkgManifest(manifest.id)).toBe(manifest);
    }
    expect(pkgManifest("no-such-tool")).toBeUndefined();
  });

  it("resolves every `requires` id to another row", () => {
    for (const manifest of PKG_MANIFESTS) {
      for (const required of manifest.requires ?? []) {
        expect(pkgManifest(required), `${manifest.id} requires ${required}`).toBeDefined();
      }
    }
  });

  it("never requires itself", () => {
    for (const manifest of PKG_MANIFESTS) {
      expect(manifest.requires ?? []).not.toContain(manifest.id);
    }
  });

  it("points every `enabledBy` at a real settings leaf", () => {
    const leaves = SETTINGS_LEAVES as unknown as Record<string, Record<string, unknown>>;
    for (const manifest of PKG_MANIFESTS) {
      if (manifest.enabledBy === undefined) continue;
      const dot = manifest.enabledBy.indexOf(".");
      expect(dot, `${manifest.id}: enabledBy must be "section.key"`).toBeGreaterThan(0);
      const section = manifest.enabledBy.slice(0, dot);
      const key = manifest.enabledBy.slice(dot + 1);
      const bag = leaves[section];
      expect(bag, `${manifest.id}: unknown settings section "${section}"`).toBeDefined();
      expect(
        bag !== undefined && key in bag,
        `${manifest.id}: unknown settings key "${manifest.enabledBy}"`,
      ).toBe(true);
    }
  });

  it("keeps tier-3b and `bundled` detection in lockstep", () => {
    for (const manifest of PKG_MANIFESTS) {
      expect(
        manifest.tier === "tier-3b",
        `${manifest.id}: tier-3b iff detect.kind === "bundled"`,
      ).toBe(manifest.detect.kind === "bundled");
    }
  });

  it("gives every row a non-empty degrade path (criterion 3 of the admission bar)", () => {
    for (const manifest of PKG_MANIFESTS) {
      expect(
        manifest.degrade.length,
        `${manifest.id}: degrade must say what happens`,
      ).toBeGreaterThan(0);
    }
  });

  it("cites an https upstream and a licence for every row", () => {
    for (const manifest of PKG_MANIFESTS) {
      expect(manifest.upstream, manifest.id).toMatch(/^https:\/\//);
      expect(manifest.licence.length, manifest.id).toBeGreaterThan(0);
    }
  });

  it("points every declared adapter at a path that exists", async () => {
    for (const manifest of PKG_MANIFESTS) {
      if (manifest.adapter === undefined) continue;
      expect(await exists(manifest.adapter), `${manifest.id}: missing ${manifest.adapter}`).toBe(
        true,
      );
    }
  });

  it("never lists a managed tool among Golem's own runtime dependencies", async () => {
    // Criterion 4: Golem ships none of a managed tool's bytes. A `module` row is
    // allowed in optionalDependencies (npm may fetch it) but never in the
    // mandatory `dependencies` set, which is what every install pays for.
    const pkg = (await import("../../../package.json", { with: { type: "json" } })).default as {
      dependencies?: Record<string, string>;
    };
    const mandatory = Object.keys(pkg.dependencies ?? {});
    for (const manifest of PKG_MANIFESTS) {
      if (manifest.detect.kind !== "module") continue;
      expect(
        mandatory,
        `${manifest.id} is a managed tool, so it must not be a mandatory dependency`,
      ).not.toContain(manifest.detect.specifier);
    }
  });
});

/**
 * R8.14 drift guards over the WRITE half. These are the invariants that make
 * `golem pkg install|remove|upgrade` safe to expose, expressed against the data
 * rather than the code path — so a new row cannot opt out of them by accident.
 */
describe("PKG_MANIFESTS installers", () => {
  it("says who governs every pin, and records an absent pin as a policy too", () => {
    for (const manifest of PKG_MANIFESTS) {
      if (manifest.pin !== undefined) {
        expect(
          manifest.pinPolicy,
          `${manifest.id}: a pin needs a policy saying who may move it`,
        ).toBeDefined();
        expect(
          manifest.pinPolicy,
          `${manifest.id}: "upstream-unpinned" contradicts having a pin`,
        ).not.toBe("upstream-unpinned");
      } else if (manifest.pinPolicy !== undefined) {
        // The only honest policy without a pin: the upstream installer exposes
        // no version selector, and the registry says so rather than staying mute.
        expect(manifest.pinPolicy, manifest.id).toBe("upstream-unpinned");
      }
    }
  });

  it("never lets a playbook-pinned row declare an upgrade path", () => {
    // The pin guard, as data: the Headroom pin moves through T-C4 only, so there
    // must be no `upgrade` recipe for a CLI verb to reach in the first place.
    for (const manifest of PKG_MANIFESTS) {
      if (manifest.pinPolicy !== "playbook") continue;
      expect(
        manifest.installer?.upgrade,
        `${manifest.id}: a playbook-pinned row must not carry upgrade steps`,
      ).toBeUndefined();
    }
  });

  it("upgrades a manifest-pinned row only by re-running install", () => {
    for (const manifest of PKG_MANIFESTS) {
      if (manifest.pinPolicy !== "manifest" || manifest.installer === undefined) continue;
      const upgrade = manifest.installer.upgrade;
      expect(
        upgrade === undefined || upgrade === "reinstall",
        `${manifest.id}: explicit upgrade steps could name a version past the pin`,
      ).toBe(true);
    }
  });

  it("spawns the manifest pin verbatim, never a re-typed version", () => {
    for (const manifest of PKG_MANIFESTS) {
      if (manifest.installer === undefined || manifest.pinPolicy !== "manifest") continue;
      const args = manifest.installer.install.flatMap((s) => s.args);
      expect(args, `${manifest.id}: install argv must contain ${manifest.pin}`).toContain(
        manifest.pin,
      );
    }
  });

  it("gives every installer step a bare command, a reason, and no shell syntax", () => {
    for (const manifest of PKG_MANIFESTS) {
      const installer = manifest.installer;
      if (installer === undefined) continue;
      expect(
        installer.upstream.length,
        `${manifest.id}: name whose installer it is`,
      ).toBeGreaterThan(0);
      const upgrade = installer.upgrade === "reinstall" ? [] : (installer.upgrade ?? []);
      const steps = [...installer.install, ...(installer.remove ?? []), ...upgrade];
      expect(installer.install.length, `${manifest.id}: install cannot be empty`).toBeGreaterThan(
        0,
      );
      for (const step of steps) {
        expect(step.command, manifest.id).toMatch(/^[a-z][a-z0-9-]*$/);
        expect(step.args.length, `${manifest.id}: ${step.command} needs arguments`).toBeGreaterThan(
          0,
        );
        expect(step.why.length, `${manifest.id}: ${step.command} needs a reason`).toBeGreaterThan(
          0,
        );
        // Argument arrays only (CLAUDE.md): no step may smuggle in a shell.
        for (const arg of step.args) expect(arg, `${manifest.id}: ${arg}`).not.toMatch(/[&|;><`$]/);
      }
    }
  });

  it("never offers an automated install for a row Golem would have to carry", async () => {
    // Criterion 4 again, from the write side: an `installer` may only invoke a
    // command, so a `module` row (something npm resolves inside Golem's own
    // install) must not pretend a project-local install would be detected.
    for (const manifest of PKG_MANIFESTS) {
      if (manifest.detect.kind !== "module") continue;
      expect(
        manifest.installer,
        `${manifest.id}: a module row is an optional dependency of Golem itself`,
      ).toBeUndefined();
    }
  });

  it("keeps a module row's pin identical to package.json", async () => {
    const pkg = (await import("../../../package.json", { with: { type: "json" } })).default as {
      optionalDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const manifest of PKG_MANIFESTS) {
      if (manifest.detect.kind !== "module" || manifest.pin === undefined) continue;
      const declared =
        pkg.optionalDependencies?.[manifest.detect.specifier] ??
        pkg.devDependencies?.[manifest.detect.specifier];
      expect(manifest.pin, `${manifest.id}: registry pin must match package.json`).toBe(declared);
    }
  });
});
