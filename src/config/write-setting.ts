/**
 * writeSetting (E1): safe read-modify-write of one setting in one scope.
 *
 * Guarantees:
 * - Validates the key against the schema table and the value against the
 *   leaf's zod schema BEFORE touching the file.
 * - Preserves unknown keys and key order in the existing file (parse + set
 *   leaf + re-serialize; JSON key order is insertion order, and existing keys
 *   keep their position).
 * - Preserves the file's indentation style (detected from the existing
 *   content; two spaces for new files) and trailing-newline convention.
 * - Refuses to overwrite a file it cannot parse — a malformed settings file
 *   is never silently clobbered.
 * - Atomic-ish: writes a temp file in the same directory, then renames over
 *   the target (rename replaces on Windows too).
 * - `value === undefined` deletes the key from the file (reverting that
 *   setting to lower layers / defaults).
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "./errors.js";
import { settingsFilePaths } from "./paths.js";
import { allLeafPaths, leafSchema } from "./schema.js";

/** Which settings file to modify. */
export type SettingsScope = "user" | "project" | "local";

export interface WriteSettingOptions {
  /** Project root containing `.golem/`; defaults to process.cwd(). */
  readonly projectDir?: string;
  /** User config dir; defaults to `~/.golem`. */
  readonly userDir?: string;
}

/**
 * Set (or, with `value === undefined`, remove) `key` — a dotted
 * `section.key` — in the given scope's settings file.
 * Returns the absolute path of the file written.
 */
export async function writeSetting(
  scope: SettingsScope,
  key: string,
  value: unknown,
  options: WriteSettingOptions = {},
): Promise<string> {
  const dotIndex = key.indexOf(".");
  const section = dotIndex === -1 ? key : key.slice(0, dotIndex);
  const leafKey = dotIndex === -1 ? "" : key.slice(dotIndex + 1);
  const leaf = leafKey === "" ? undefined : leafSchema(section, leafKey);
  if (leaf === undefined) {
    throw new ConfigError(
      `unknown setting "${key}"; valid keys are: ${allLeafPaths().join(", ")}`,
      { key },
    );
  }

  let validated: unknown;
  if (value === undefined) {
    validated = undefined; // delete semantics
  } else {
    const parsed = leaf.safeParse(value);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => i.message).join("; ");
      throw new ConfigError(`invalid value for "${key}": ${issues}`, { key });
    }
    validated = parsed.data;
  }

  const files = settingsFilePaths(options);
  const file = files[scope];

  const existing = await readExisting(file);
  const root = existing.root;
  const sectionValue = root[section];
  if (sectionValue !== undefined && !isPlainObject(sectionValue)) {
    throw new ConfigError(
      `${file}: section "${section}" is not an object; refusing to overwrite it`,
      { source: file, key: section },
    );
  }

  if (validated === undefined) {
    if (isPlainObject(sectionValue)) {
      delete sectionValue[leafKey];
    }
  } else {
    const target = isPlainObject(sectionValue) ? sectionValue : {};
    target[leafKey] = validated;
    root[section] = target;
  }

  const text = JSON.stringify(root, null, existing.indent) + (existing.trailingNewline ? "\n" : "");

  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw new ConfigError(
      `failed to write settings file ${file}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      { source: file, key },
    );
  }
  return file;
}

interface ExistingFile {
  readonly root: Record<string, unknown>;
  readonly indent: string;
  readonly trailingNewline: boolean;
}

async function readExisting(file: string): Promise<ExistingFile> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { root: {}, indent: "  ", trailingNewline: true };
    }
    throw new ConfigError(
      `cannot read settings file ${file}: ${err instanceof Error ? err.message : String(err)}`,
      { source: file },
    );
  }
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (stripped.trim() === "") {
    return { root: {}, indent: "  ", trailingNewline: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new ConfigError(
      `settings file ${file} contains invalid JSON — fix or remove it before writing: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      { source: file },
    );
  }
  if (!isPlainObject(parsed)) {
    throw new ConfigError(`settings file ${file} must contain a JSON object at the root`, {
      source: file,
    });
  }
  const indentMatch = stripped.match(/\n([ \t]+)\S/);
  return {
    root: parsed,
    indent: indentMatch?.[1] ?? "  ",
    trailingNewline: stripped.endsWith("\n"),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
