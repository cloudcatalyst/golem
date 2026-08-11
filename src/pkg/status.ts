/**
 * Live status for each managed-package registry row (spec Decision 53).
 *
 * Pure over its inputs: detection is injectable and settings are passed in, so
 * every state below is reachable in a unit test without installing anything.
 *
 * Deliberately does NOT report "running". A process probe would be a different,
 * heavier surface (and for the Headroom sidecars "running" is a transient — they
 * are spawned per use), so instead the manifest's `gate` explains why *enabled*
 * may still mean *idle*. Claiming "running" without probing would be exactly the
 * kind of dishonest surface this project exists to avoid.
 */

import type { GolemSettings } from "../config/schema.js";
import { commandOnPath, moduleOnDisk, pluginOnDisk } from "./detect.js";
import { PKG_MANIFESTS, type PkgManifest } from "./manifest.js";

/** Coarse state, in the order a reader cares about. */
export type PkgState =
  /** Golem's own bundled data (tier-3b) — nothing to install or enable. */
  | "bundled"
  /** Not present on this machine. Its `degrade` behaviour is in effect. */
  | "not-installed"
  /** Present, but a prerequisite row is missing, so it cannot be used. */
  | "blocked"
  /** Present and usable, but switched off in settings. */
  | "disabled"
  /** Present and switched on. See `gate` before concluding it is *running*. */
  | "enabled"
  /** Present, and it has no on/off setting (it is a peer, or a prerequisite). */
  | "present";

export interface PkgStatus {
  readonly id: string;
  readonly manifest: PkgManifest;
  /** Whether detection found it. Always true for `bundled`. */
  readonly installed: boolean;
  /** Where it was found (executable path or resolved module), when known. */
  readonly where: string | null;
  /** Effective on/off from settings; `null` when the row has no such setting. */
  readonly enabled: boolean | null;
  /** The raw setting value, rendered for display; `null` when not applicable. */
  readonly settingValue: string | null;
  /** Ids of `requires` rows that are not installed. */
  readonly missingRequirements: readonly string[];
  readonly state: PkgState;
}

/** Injectable probes, so tests never touch the real PATH or `node_modules`. */
export interface PkgProbes {
  readonly command: (name: string) => string | null;
  readonly module: (specifier: string) => string | null;
  readonly plugin: (name: string, marketplace?: string) => string | null;
}

const DEFAULT_PROBES: PkgProbes = {
  command: commandOnPath,
  module: moduleOnDisk,
  plugin: pluginOnDisk,
};

export interface ResolvePkgOptions {
  /** Effective settings, for `enabledBy` resolution. Omit to report `null`. */
  readonly settings?: GolemSettings;
  readonly manifests?: readonly PkgManifest[];
  readonly probes?: PkgProbes;
}

/** Read a `section.key` path out of settings without widening its type. */
function readSetting(settings: GolemSettings, dotted: string): unknown {
  const dot = dotted.indexOf(".");
  if (dot <= 0) return undefined;
  const section = dotted.slice(0, dot);
  const key = dotted.slice(dot + 1);
  const bag = (settings as unknown as Record<string, Record<string, unknown> | undefined>)[section];
  return bag === undefined ? undefined : bag[key];
}

/**
 * Interpret a setting value as on/off. Booleans are themselves; a string is off
 * only when it literally says so (`brevity.level: "off"`); a number is on when
 * positive. Anything unrecognised is treated as *on*, because a row that exists
 * and is set to something is more likely enabled than not, and over-reporting
 * "enabled" is the safer error for a surface whose job is to prompt a check.
 */
function interpretEnabled(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value !== "off" && value !== "none" && value !== "";
  if (typeof value === "number") return value > 0;
  return true;
}

function renderValue(value: unknown): string | null {
  if (value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function detectOne(manifest: PkgManifest, probes: PkgProbes): string | null {
  switch (manifest.detect.kind) {
    case "command":
      return probes.command(manifest.detect.command);
    case "module":
      return probes.module(manifest.detect.specifier);
    case "plugin":
      return probes.plugin(manifest.detect.name, manifest.detect.marketplace);
    case "bundled":
      return null;
  }
}

/** Resolve every registry row against this machine and these settings. */
export function resolvePkgStatuses(options: ResolvePkgOptions = {}): readonly PkgStatus[] {
  const manifests = options.manifests ?? PKG_MANIFESTS;
  const probes = options.probes ?? DEFAULT_PROBES;

  // First pass: presence only, so `requires` can be resolved against it.
  const found = new Map<string, string | null>();
  for (const manifest of manifests) {
    found.set(manifest.id, detectOne(manifest, probes));
  }
  const isPresent = (id: string): boolean => {
    const manifest = manifests.find((m) => m.id === id);
    if (manifest === undefined) return false;
    return manifest.detect.kind === "bundled" || found.get(id) !== null;
  };

  return manifests.map((manifest): PkgStatus => {
    const bundled = manifest.detect.kind === "bundled";
    const where = found.get(manifest.id) ?? null;
    const installed = bundled || where !== null;

    const rawValue =
      manifest.enabledBy !== undefined && options.settings !== undefined
        ? readSetting(options.settings, manifest.enabledBy)
        : undefined;
    const enabled = manifest.enabledBy === undefined ? null : interpretEnabled(rawValue);

    const missingRequirements = (manifest.requires ?? []).filter((id) => !isPresent(id));

    const state: PkgState = bundled
      ? "bundled"
      : !installed
        ? "not-installed"
        : missingRequirements.length > 0
          ? "blocked"
          : enabled === null
            ? "present"
            : enabled
              ? "enabled"
              : "disabled";

    return {
      id: manifest.id,
      manifest,
      installed,
      where,
      enabled,
      settingValue: renderValue(rawValue),
      missingRequirements,
      state,
    };
  });
}
