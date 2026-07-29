/**
 * WS-E E3 — `golem slider` engine: show or set the quality/savings slider.
 *
 * Reads go through the E1 config loader (so provenance says WHICH layer set
 * the effective level); writes go through `writeSetting` on the LOCAL scope
 * (`<project>/.golem/settings.local.json`, nested `slider.level`, gitignored) —
 * the slider is a personal, frequently-changed dial, so its writes must not
 * dirty the committed `settings.json` (spec Decision 43). The reconciled MCP
 * JsonFileSliderStore writes the same local file and key, so `/mcp__golem__level`,
 * `golem slider`, and `loadConfig()` all see one value (verification-notes §20).
 */

import { loadConfig, writeSetting } from "../config/index.js";
import type { SliderLevel } from "../interfaces/policy.js";
import { golemInit, golemInitStatus, type InitProbe } from "./init.js";
import { getSliderInfo, type SliderInfo } from "./slider-read.js";

// The read half lives in ./slider-read.js so that displaying the level doesn't
// have to load `./init.js` (and the hooks barrel behind it) — see that file. Both
// are re-exported here so every existing importer of `slider.js` is unaffected.
export type { SliderInfo, SliderReadOptions } from "./slider-read.js";
export { getSliderInfo, SLIDER_LEVEL_NAMES } from "./slider-read.js";

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

export interface SetSliderResult {
  /** Absolute path of the settings file written (local scope, gitignored). */
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
 * Persist `slider.level` at LOCAL scope (gitignored settings.local.json), then
 * report the effective value. The slider is a personal, transient dial — its
 * writes must not churn the committed `settings.json` (spec Decision 43).
 *
 * Choosing a level is what activates Golem in a project: if it hasn't been
 * initialized yet (no `.golem/settings.json`, no MCP/skills wiring), this runs
 * the full `golemInit` flow at the chosen level first, rather than writing an
 * orphaned settings file with none of the rest of the wiring.
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
  const file = await writeSetting("local", "slider.level", level, loadOpts(options));
  const effective = await getSliderInfo(options);
  const overridden = effective.layer !== "local" || effective.level !== level;
  return {
    file,
    effective,
    ...(overridden && { overriddenBy: effective }),
    ...(!status.initialized && { justInitialized: true }),
  };
}
