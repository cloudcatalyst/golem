/**
 * The READ half of the slider (`SLIDER_LEVEL_NAMES` + {@link getSliderInfo}),
 * split out of slider.ts purely so reading the level is cheap to import.
 *
 * Reading is just a config lookup. Writing (`setSliderLevel`) has to be able to
 * activate a project, so slider.ts imports `./init.js` — which drags in the hooks
 * barrel and costs ~530ms to load. Anything that only wants to *display* the level
 * (the `golem ui` panel, the status line, `golem status`) imports this module
 * instead and pays ~130ms. See verification-notes §86.
 *
 * slider.ts re-exports both of these, so existing importers are unaffected and
 * there is still one source of truth for the names.
 */

import { type LayerName, loadConfig } from "../config/index.js";
import type { SliderLevel } from "../interfaces/policy.js";

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

/** Options for reading the level (test injection). */
export interface SliderReadOptions {
  readonly projectDir: string;
  readonly userDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Effective slider level with provenance. */
export async function getSliderInfo(options: SliderReadOptions): Promise<SliderInfo> {
  const { settings, provenance } = await loadConfig({
    projectDir: options.projectDir,
    ...(options.userDir !== undefined && { userDir: options.userDir }),
    ...(options.env !== undefined && { env: options.env }),
  });
  const level = settings.slider.level;
  const entry = provenance["slider.level"];
  return {
    level,
    name: SLIDER_LEVEL_NAMES[level],
    layer: entry?.layer ?? "default",
    ...(entry?.source !== undefined && { source: entry.source }),
  };
}
