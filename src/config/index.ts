/**
 * WS-E E1: settings hierarchy loader (owned by agent-ux).
 *
 * Precedence (lowest → highest):
 *   defaults → `~/.golem/settings.json` (user) → `<project>/.golem/settings.json`
 *   (project) → `<project>/.golem/settings.local.json` (local) →
 *   `GOLEM_<SECTION>_<KEY>` env vars → per-request overrides.
 *
 * Entry points:
 * - {@link loadConfig} — typed, deeply frozen settings + per-key provenance.
 * - {@link writeSetting} — safe read-modify-write of one key in one scope.
 * - {@link policyFromSettings} — SliderPolicy for the effective settings.
 *
 * Env mapping rules are documented in env.ts; merge/error semantics in
 * loader.ts; the key set and defaults in schema.ts.
 */

import { type SliderPolicy, sliderPolicyForLevel } from "../interfaces/policy.js";
import type { GolemSettings } from "./schema.js";

export type { EnvLayer, EnvOverride } from "./env.js";
export { coerceEnvValue, ENV_PREFIX, readEnvLayer } from "./env.js";
export { ConfigError } from "./errors.js";
export type {
  GolemConfig,
  LayerName,
  LoadConfigOptions,
  Provenance,
  ProvenanceEntry,
  SettingsOverrides,
} from "./loader.js";
export { loadConfig } from "./loader.js";
export type { SettingsFilePaths } from "./paths.js";
export {
  defaultUserDir,
  LOCAL_SETTINGS_FILE,
  PROJECT_DIR_NAME,
  SETTINGS_FILE,
  settingsFilePaths,
  USER_DIR_NAME,
} from "./paths.js";
export type {
  GolemSettings,
  InferenceSettings,
  KnowledgeSettings,
  ProxySettings,
  SectionName,
  SliderSettings,
  TelemetrySettings,
} from "./schema.js";
export { allLeafPaths, DEFAULT_SETTINGS, leafSchema, SECTION_NAMES } from "./schema.js";
export type { SettingsScope, WriteSettingOptions } from "./write-setting.js";
export { writeSetting } from "./write-setting.js";

/**
 * Typed accessor for the slider policy implied by the effective settings
 * (interfaces/policy.ts is the frozen contract; this just feeds it).
 */
export function policyFromSettings(settings: GolemSettings): SliderPolicy {
  return sliderPolicyForLevel(settings.slider.level);
}
