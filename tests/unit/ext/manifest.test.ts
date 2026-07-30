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
import { EXT_MANIFESTS, extManifest } from "../../../src/ext/index.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function exists(relative: string): Promise<boolean> {
  try {
    await stat(path.join(REPO_ROOT, relative));
    return true;
  } catch {
    return false;
  }
}

describe("EXT_MANIFESTS", () => {
  it("is not empty", () => {
    expect(EXT_MANIFESTS.length).toBeGreaterThan(0);
  });

  it("has unique, kebab-case ids", () => {
    const ids = EXT_MANIFESTS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("finds every row by id via extManifest", () => {
    for (const manifest of EXT_MANIFESTS) {
      expect(extManifest(manifest.id)).toBe(manifest);
    }
    expect(extManifest("no-such-tool")).toBeUndefined();
  });

  it("resolves every `requires` id to another row", () => {
    for (const manifest of EXT_MANIFESTS) {
      for (const required of manifest.requires ?? []) {
        expect(extManifest(required), `${manifest.id} requires ${required}`).toBeDefined();
      }
    }
  });

  it("never requires itself", () => {
    for (const manifest of EXT_MANIFESTS) {
      expect(manifest.requires ?? []).not.toContain(manifest.id);
    }
  });

  it("points every `enabledBy` at a real settings leaf", () => {
    const leaves = SETTINGS_LEAVES as unknown as Record<string, Record<string, unknown>>;
    for (const manifest of EXT_MANIFESTS) {
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
    for (const manifest of EXT_MANIFESTS) {
      expect(
        manifest.tier === "tier-3b",
        `${manifest.id}: tier-3b iff detect.kind === "bundled"`,
      ).toBe(manifest.detect.kind === "bundled");
    }
  });

  it("gives every row a non-empty degrade path (criterion 3 of the admission bar)", () => {
    for (const manifest of EXT_MANIFESTS) {
      expect(
        manifest.degrade.length,
        `${manifest.id}: degrade must say what happens`,
      ).toBeGreaterThan(0);
    }
  });

  it("cites an https upstream and a licence for every row", () => {
    for (const manifest of EXT_MANIFESTS) {
      expect(manifest.upstream, manifest.id).toMatch(/^https:\/\//);
      expect(manifest.licence.length, manifest.id).toBeGreaterThan(0);
    }
  });

  it("points every declared adapter at a path that exists", async () => {
    for (const manifest of EXT_MANIFESTS) {
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
    for (const manifest of EXT_MANIFESTS) {
      if (manifest.detect.kind !== "module") continue;
      expect(
        mandatory,
        `${manifest.id} is a managed tool, so it must not be a mandatory dependency`,
      ).not.toContain(manifest.detect.specifier);
    }
  });
});
