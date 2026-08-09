/**
 * WS-E E1b — `golem config` engine: read/write validated Golem settings.
 *
 * Builds on the E1 loader and `writeSetting` so the CLI cannot invent keys or
 * write schema-invalid values. All reads show the effective value plus the
 * layer that supplied it; all writes target one scope (user/project/local) and
 * report the effective value after the write in case a higher layer overrides.
 */

import { readFile } from "node:fs/promises";
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

/**
 * R9.9 — resolve `golem config set`'s value argument: the positional `<value>`,
 * or `--value-file <path>` (with `-` meaning stdin).
 *
 * The escape hatch exists because JSON on the command line is a shell fight:
 * PowerShell, cmd and POSIX shells each quote embedded `"` differently, and a
 * user who loses that fight gets a JSON parse error rather than a setting.
 * Exactly one source must be given — silently preferring one over the other
 * would write a value the user did not intend.
 */
export async function resolveSetValue(
  value: string | undefined,
  valueFile: string | undefined,
  io: {
    readonly readFile?: (p: string) => Promise<string>;
    readonly readStdin?: () => Promise<string>;
  } = {},
): Promise<string> {
  if (value !== undefined && valueFile !== undefined) {
    throw new ConfigError("pass either <value> or --value-file, not both");
  }
  if (value !== undefined) return value;
  if (valueFile === undefined) {
    throw new ConfigError(
      "missing value: pass it as an argument, or use --value-file <path> (or --value-file - for stdin)",
    );
  }
  if (valueFile === "-") {
    const readStdin = io.readStdin ?? defaultReadStdin;
    return stripBom(await readStdin()).trim();
  }
  const read = io.readFile ?? ((p: string) => readFile(p, "utf8"));
  try {
    return stripBom(await read(valueFile)).trim();
  } catch (err) {
    throw new ConfigError(
      `cannot read --value-file ${valueFile}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** A UTF-8 BOM — what Windows editors and `Out-File -Encoding utf8BOM` leave behind — is not JSON. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

async function defaultReadStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new ConfigError("--value-file - expects the value on stdin, but stdin is a terminal");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
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
      return parseJsonValue(key, trimmed, "array");
    }
    return trimmed
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
  }

  // R9.9: object-valued leaves (`z.record`, `z.object`) are JSON. Without this
  // branch the raw string reached zod untouched and failed with "Expected
  // object, received string" — a symptom that hid the cause, and left
  // `compression.headroom_config` settable only by hand-editing the file.
  if (target instanceof z.ZodRecord || target instanceof z.ZodObject) {
    return parseJsonValue(key, raw.trim(), "object");
  }

  // Strings and URLs: pass through and let zod validate in writeSetting.
  return raw;
}

/**
 * Parse `raw` as JSON for a leaf that expects `expected` ("object" | "array"),
 * failing with a message that names the *cause* (bad JSON, or valid JSON of the
 * wrong shape) rather than the downstream zod symptom.
 */
function parseJsonValue(key: string, raw: string, expected: "object" | "array"): unknown {
  if (raw === "") {
    throw new ConfigError(
      `"${key}" expects a JSON ${expected}, got an empty value` +
        ` (pass ${expected === "object" ? "{}" : "[]"} to clear it, or \`golem config unset ${key}\`)`,
      { key },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(
      `invalid JSON for "${key}": ${err instanceof Error ? err.message : String(err)}` +
        ` — got ${JSON.stringify(raw)}.` +
        ` If your shell is eating the quotes, use \`--value-file <path>\` or \`--value-file -\` (stdin).`,
      { key },
    );
  }
  if (jsonShapeOf(parsed) !== expected) {
    throw new ConfigError(
      `"${key}" expects a JSON ${expected}, got ${jsonShapeOf(parsed)}: ${JSON.stringify(parsed)}`,
      { key },
    );
  }
  return parsed;
}

/** Structural equality over JSON-shaped settings values (scalars, arrays, objects). */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameValue(item, b[index]));
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (k) =>
      Object.hasOwn(b as Record<string, unknown>, k) &&
      sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

function jsonShapeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
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
  // Structural, not reference, comparison: an object- or array-valued leaf read
  // back through the loader is a different object every time, so `!==` reported
  // every such write as overridden by a layer that had not overridden anything.
  const overridden = effective.layer !== scope || !sameValue(effective.value, value);
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
