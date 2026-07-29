/**
 * WS-E E1b — `golem config` engine: read/write validated Golem settings.
 *
 * Builds on the E1 loader and `writeSetting` so the CLI cannot invent keys or
 * write schema-invalid values. All reads show the effective value plus the
 * layer that supplied it; all writes target one scope (user/project/local) and
 * report the effective value after the write in case a higher layer overrides.
 */

import { z } from "zod";
import { ConfigError } from "../config/errors.js";
import { loadConfig, type SettingsScope, writeSetting } from "../config/index.js";
import { allLeafPaths, leafSchema } from "../config/schema.js";
import { unwrapSchema } from "../config/ui-model.js";

export interface ConfigReadOptions {
  readonly projectDir: string;
  readonly userDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ConfigEntry {
  readonly key: string;
  readonly value: unknown;
  readonly layer: string;
  readonly source?: string;
}

export interface ConfigListReport {
  readonly entries: readonly ConfigEntry[];
}

export interface ConfigGetReport {
  readonly key: string;
  readonly value: unknown;
  readonly layer: string;
  readonly source?: string;
}

export interface ConfigWriteResult {
  readonly key: string;
  readonly value: unknown;
  readonly scope: SettingsScope;
  readonly file: string;
  readonly effective: ConfigGetReport;
  readonly overriddenBy?: ConfigGetReport;
}

/** List every known setting with its effective value and provenance. */
export async function listConfig(options: ConfigReadOptions): Promise<ConfigListReport> {
  const { settings, provenance } = await loadConfig({
    projectDir: options.projectDir,
    ...(options.userDir !== undefined && { userDir: options.userDir }),
    ...(options.env !== undefined && { env: options.env }),
  });

  const entries: ConfigEntry[] = [];
  for (const path of allLeafPaths()) {
    const [section, key] = path.split(".", 2) as [string, string];
    const sectionValues = settings as unknown as Record<string, Record<string, unknown>>;
    const entry = provenance[path];
    entries.push({
      key: path,
      value: sectionValues[section]?.[key],
      layer: entry?.layer ?? "default",
      ...(entry?.source !== undefined && { source: entry.source }),
    });
  }
  return { entries };
}

/** Read one effective setting by dotted `section.key`. */
export async function getConfig(key: string, options: ConfigReadOptions): Promise<ConfigGetReport> {
  validateKnownKey(key);
  const { settings, provenance } = await loadConfig({
    projectDir: options.projectDir,
    ...(options.userDir !== undefined && { userDir: options.userDir }),
    ...(options.env !== undefined && { env: options.env }),
  });
  const [section, leafKey] = key.split(".", 2) as [string, string];
  const sectionValues = settings as unknown as Record<string, Record<string, unknown>>;
  const entry = provenance[key];
  return {
    key,
    value: sectionValues[section]?.[leafKey],
    layer: entry?.layer ?? "default",
    ...(entry?.source !== undefined && { source: entry.source }),
  };
}

/** Parse and validate a raw CLI string into the schema type for `key`. */
export function parseConfigValue(key: string, raw: string): unknown {
  const leaf = leafForKey(key);
  if (leaf === undefined) {
    throw new ConfigError(
      `unknown setting "${key}"; valid keys are: ${allLeafPaths().join(", ")}`,
      { key },
    );
  }
  const target = unwrapSchema(leaf);

  if (target instanceof z.ZodBoolean) {
    const token = raw.trim().toLowerCase();
    if (token === "true" || token === "1" || token === "yes" || token === "on") return true;
    if (token === "false" || token === "0" || token === "no" || token === "off") return false;
    throw new ConfigError(
      `"${key}" expects a boolean (true/false/1/0/yes/no/on/off), got "${raw}"`,
      { key },
    );
  }

  if (target instanceof z.ZodNumber) {
    const num = Number(raw.trim());
    if (!Number.isFinite(num)) {
      throw new ConfigError(`"${key}" expects a number, got "${raw}"`, { key });
    }
    return num;
  }

  if (target instanceof z.ZodArray) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed);
      } catch (err) {
        throw new ConfigError(
          `"${key}" expects a JSON array, got "${raw}" (${err instanceof Error ? err.message : String(err)})`,
          { key },
        );
      }
    }
    return trimmed
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
  }

  // Strings and URLs: pass through and let zod validate in writeSetting.
  return raw;
}

/** Write `value` to `scope`, then return the effective value (which may be overridden). */
export async function setConfig(
  scope: SettingsScope,
  key: string,
  raw: string,
  options: ConfigReadOptions,
): Promise<ConfigWriteResult> {
  validateKnownKey(key);
  const value = parseConfigValue(key, raw);
  const file = await writeSetting(scope, key, value, {
    projectDir: options.projectDir,
    ...(options.userDir !== undefined && { userDir: options.userDir }),
  });
  const effective = await getConfig(key, options);
  const overridden = effective.layer !== scope || effective.value !== value;
  return {
    key,
    value,
    scope,
    file,
    effective,
    ...(overridden && { overriddenBy: effective }),
  };
}

/** Remove `key` from `scope`, returning the effective value after deletion. */
export async function unsetConfig(
  scope: SettingsScope,
  key: string,
  options: ConfigReadOptions,
): Promise<{ key: string; scope: SettingsScope; file: string; effective: ConfigGetReport }> {
  validateKnownKey(key);
  const file = await writeSetting(scope, key, undefined, {
    projectDir: options.projectDir,
    ...(options.userDir !== undefined && { userDir: options.userDir }),
  });
  const effective = await getConfig(key, options);
  return { key, scope, file, effective };
}

/** Human rendering of `config list`. */
export function renderConfigList(report: ConfigListReport): string {
  if (report.entries.length === 0) return "No settings defined.\n";
  const lines: string[] = [];
  for (const entry of report.entries) {
    const source = entry.source !== undefined ? ` (${entry.source})` : "";
    lines.push(`  ${entry.key} = ${JSON.stringify(entry.value)} — ${entry.layer}${source}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Human rendering of `config get`. */
export function renderConfigGet(report: ConfigGetReport): string {
  const source = report.source !== undefined ? ` (${report.source})` : "";
  return `${report.key} = ${JSON.stringify(report.value)} — ${report.layer}${source}\n`;
}

/** Human rendering of `config set`. */
export function renderConfigSet(result: ConfigWriteResult): string {
  const lines: string[] = [
    `${result.key} set to ${JSON.stringify(result.value)} in ${result.file} (${result.scope} scope)`,
  ];
  const eff = result.effective;
  const source = eff.source !== undefined ? ` (${eff.source})` : "";
  lines.push(`effective value: ${JSON.stringify(eff.value)} — ${eff.layer}${source}`);
  if (result.overriddenBy !== undefined) {
    const o = result.overriddenBy;
    const oSource = o.source !== undefined ? ` (${o.source})` : "";
    lines.push(
      `note: a higher-precedence layer overrides it — effective value is from ${o.layer}${oSource}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Human rendering of `config unset`. */
export function renderConfigUnset(result: {
  readonly key: string;
  readonly scope: SettingsScope;
  readonly file: string;
  readonly effective: ConfigGetReport;
}): string {
  const eff = result.effective;
  const source = eff.source !== undefined ? ` (${eff.source})` : "";
  return (
    `${result.key} removed from ${result.scope} scope (${result.file})\n` +
    `effective value: ${JSON.stringify(eff.value)} — ${eff.layer}${source}\n`
  );
}

function validateKnownKey(key: string): void {
  if (leafForKey(key) === undefined) {
    throw new ConfigError(
      `unknown setting "${key}"; valid keys are: ${allLeafPaths().join(", ")}`,
      { key },
    );
  }
}

function leafForKey(key: string) {
  const dotIndex = key.indexOf(".");
  if (dotIndex === -1) return undefined;
  const section = key.slice(0, dotIndex);
  const leafKey = key.slice(dotIndex + 1);
  return leafSchema(section, leafKey);
}

// The wrapper-stripping helper this used to own now lives in config/ui-model.ts
// as `unwrapSchema`, shared with the control surface so the CLI's value parsing
// and the panel's widget choice can never disagree about a leaf's real type.
