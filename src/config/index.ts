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
 * - {@link policyFromSettings} — PipelinePolicy for the effective settings.
 *
 * Env mapping rules are documented in env.ts; merge/error semantics in
 * loader.ts; the key set and defaults in schema.ts.
 */

import {
  type BrevityLevel,
  type CompressionLevel,
  coerceCompressionLevel,
  type PipelinePolicy,
  policyFor,
} from "../interfaces/policy.js";
import type { GolemSettings } from "./schema.js";

// `./control-surface.js` is deliberately NOT re-exported from this barrel.
//
// It reaches into src/cli (status, init, proxy-daemon, slider, accounts) and
// src/hooks, so re-exporting it dragged that entire graph into every consumer of
// `loadConfig` — including src/hooks/pre-tool-use.ts, which runs on EVERY Claude
// Code tool call. Measured: this barrel went from ~130ms to ~530ms to import.
// Consumers import it directly from "../config/control-surface.js" instead.

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
export type {
  MigrationSweep,
  ScopeResult,
  SettingChange,
  SweepOptions,
  VersionMigrationOutcome,
} from "./migrate-files.js";
export {
  backupPath,
  migrateOnVersionChange,
  readVersionStamp,
  removeVersionStamp,
  renderSweep,
  sweepSettingsFiles,
  versionStampPath,
  writeVersionStamp,
} from "./migrate-files.js";
export type { SettingsFilePaths } from "./paths.js";
export {
  defaultUserDir,
  findProjectDir,
  LOCAL_SETTINGS_FILE,
  PROJECT_DIR_NAME,
  SETTINGS_FILE,
  settingsFilePaths,
  USER_DIR_NAME,
} from "./paths.js";
export type {
  ClaudeSettings,
  CompressionSettings,
  GolemSettings,
  InferenceSettings,
  KnowledgeSettings,
  ProxySettings,
  SectionName,
  SnoozeSettings,
  TelemetrySettings,
  UiSettings,
} from "./schema.js";
export { allLeafPaths, DEFAULT_SETTINGS, leafSchema, SECTION_NAMES } from "./schema.js";
export type { LeafPath, SectionMeta, SettingKind, SettingMeta } from "./ui-model.js";
export {
  deriveKind,
  enumOptionsFor,
  numericRangeFor,
  SECTION_META,
  SETTING_META,
  sectionMeta,
  sectionsInDisplayOrder,
  settingKind,
  settingMeta,
  unwrapSchema,
} from "./ui-model.js";
export type { SettingsScope, WriteSettingOptions } from "./write-setting.js";
export { writeSetting } from "./write-setting.js";

/**
 * R11.1 — the two dials, read out of settings in the shape {@link policyFor}
 * wants.
 *
 * `brevity.level` is already exactly a `BrevityLevel`. `compression.level` is a
 * string enum in settings (so the panel renders a picker and env overrides are
 * plain strings) and is narrowed here. No value of either can disable redaction
 * (ADR-0004) — that is `proxy.bypass_all`, which the proxy applies before the
 * pipeline is consulted at all.
 */
export function dialsFromSettings(settings: GolemSettings): {
  readonly brevity: BrevityLevel;
  readonly compression: CompressionLevel;
} {
  return {
    brevity: settings.brevity.level,
    compression: coerceCompressionLevel(settings.compression.level),
  };
}

/**
 * Typed accessor for the pipeline policy implied by the effective settings
 * (interfaces/policy.ts is the frozen contract; this just feeds it).
 */
export function policyFromSettings(settings: GolemSettings): PipelinePolicy {
  const dials = dialsFromSettings(settings);
  return policyFor(dials.compression, { brevity: dials.brevity });
}
