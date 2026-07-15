/**
 * WS-E E3 — `golem slider` engine: show or set the quality/savings slider.
 *
 * Reads go through the E1 config loader (so provenance says WHICH layer set
 * the effective level); writes go through `writeSetting` on the PROJECT scope
 * (`<project>/.golem/settings.json`, nested `slider.level`) — the same file
 * and key the reconciled MCP JsonFileSliderStore uses, so `/mcp__golem__slider`,
 * `golem slider`, and `loadConfig()` all see one value (verification-notes §20).
 */

import { type LayerName, loadConfig, writeSetting } from "../config/index.js";
import type { SliderLevel } from "../interfaces/policy.js";
import { golemInit, golemInitStatus, type InitProbe } from "./init.js";

/** Human names for the four levels (spec §4 / interfaces/policy.ts, Decision 30). */
export const SLIDER_LEVEL_NAMES: Readonly<Record<SliderLevel, string>> = {
  0: "passthrough",
  1: "lossless",
  2: "balanced",
  3: "aggressive",
};

/** The effective slider level plus where it came from. */
export interface SliderInfo {
  readonly level: SliderLevel;
  readonly name: string;
  /** Which settings layer supplied the effective value. */
  readonly layer: LayerName;
  /** File path or env var behind that layer (absent for defaults/overrides). */
  readonly source?: string;
}

/** Options shared by the read/write entry points (test injection). */
export interface SliderOptions {
  readonly projectDir: string;
  readonly userDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** External-state probe forwarded to `golemInit` on first activation (tests). */
  readonly probe?: InitProbe;
}

function loadOpts(options: SliderOptions): {
  projectDir: string;
  userDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
} {
  return {
    projectDir: options.projectDir,
    ...(options.userDir !== undefined && { userDir: options.userDir }),
    ...(options.env !== undefined && { env: options.env }),
  };
}

/** Effective slider level with provenance. */
export async function getSliderInfo(options: SliderOptions): Promise<SliderInfo> {
  const { settings, provenance } = await loadConfig(loadOpts(options));
  const level = settings.slider.level;
  const entry = provenance["slider.level"];
  return {
    level,
    name: SLIDER_LEVEL_NAMES[level],
    layer: entry?.layer ?? "default",
    ...(entry?.source !== undefined && { source: entry.source }),
  };
}

export interface SetSliderResult {
  /** Absolute path of the settings file written (project scope). */
  readonly file: string;
  /** Effective level AFTER the write (a higher layer may still override). */
  readonly effective: SliderInfo;
  /** Set when a higher-precedence layer overrides the value just written. */
  readonly overriddenBy?: SliderInfo;
  /**
   * Set when this call activated a not-yet-initialized project (ran the full
   * `golemInit` wiring — MCP registration, skills, CLAUDE.local.md guidance —
   * instead of just persisting a lone setting). Golem never creates `.golem/`
   * or wires MCP/skills until a level is first chosen.
   */
  readonly justInitialized?: true;
}

/**
 * Persist `slider.level` at project scope, then report the effective value.
 *
 * Choosing a level is what activates Golem in a project: if it hasn't been
 * initialized yet (no `.golem/settings.json`, no MCP/skills wiring), this runs
 * the full `golemInit` flow at the chosen level first, rather than writing an
 * orphaned `.golem/settings.json` with none of the rest of the wiring.
 */
export async function setSliderLevel(
  level: SliderLevel,
  options: SliderOptions,
): Promise<SetSliderResult> {
  // Resolve the real per-project proxy port before checking init status — a
  // fresh project's config default (4653) matches DEFAULT_PROXY_PORT, but an
  // already-initialized project persists its own `defaultProjectPort()` value
  // in `.golem/settings.json`, which `loadConfig` then surfaces. Checking
  // against the wrong port makes `claudeSettingsWired` (and thus `initialized`)
  // misreport `false` for real, already-active projects (mirrors status.ts).
  const { settings } = await loadConfig(loadOpts(options));
  const status = await golemInitStatus(options.projectDir, settings.proxy.port);
  if (!status.initialized) {
    await golemInit({
      projectDir: options.projectDir,
      initialLevel: level,
      ...(options.probe !== undefined && { probe: options.probe }),
    });
  }
  const file = await writeSetting("project", "slider.level", level, loadOpts(options));
  const effective = await getSliderInfo(options);
  const overridden = effective.layer !== "project" || effective.level !== level;
  return {
    file,
    effective,
    ...(overridden && { overriddenBy: effective }),
    ...(!status.initialized && { justInitialized: true }),
  };
}
