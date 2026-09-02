/**
 * Layered config loader (E1).
 *
 * Precedence (lowest → highest):
 *   defaults → user (`~/.golem/settings.json`) → project
 *   (`<project>/.golem/settings.json`) → local
 *   (`<project>/.golem/settings.local.json`) → environment
 *   (`GOLEM_<SECTION>_<KEY>`, see env.ts) → per-request overrides
 *   (in-memory partial passed by the caller).
 *
 * Merging is per LEAF (`section.key`): a layer that sets `proxy.port` does
 * not disturb `proxy.upstream_base_url` from a lower layer. Arrays replace
 * wholesale (no element merging).
 *
 * Error/warning policy (deterministic, applied identically to every layer):
 * - Missing files, empty/whitespace-only files: fine — layer contributes
 *   nothing.
 * - Malformed JSON, non-object roots/sections, or a KNOWN key with an
 *   invalid value: hard ConfigError naming the file (or env var / overrides
 *   layer) and the `section.key`.
 * - UNKNOWN sections/keys: ignored with a warning (collected on the result).
 *   They are tolerated — not fatal — so files written by newer Golem versions
 *   or carrying third-party keys still load, and `writeSetting` round-trips
 *   preserve them. `null` is not a valid way to unset a key (delete the key,
 *   or use `writeSetting(scope, key, undefined)`).
 */

import { readFile } from "node:fs/promises";
import { readEnvLayer } from "./env.js";
import { ConfigError } from "./errors.js";
import { isPlainObject, splitDotted } from "./file-io.js";
import {
  migrationFrom,
  migrationShadowedWarning,
  migrationWarning,
  retirementFor,
  retirementMessage,
} from "./migrations.js";
import { type SettingsFilePaths, settingsFilePaths } from "./paths.js";
import {
  DEFAULT_SETTINGS,
  deepFreeze,
  type GolemSettings,
  leafSchema,
  SECTION_NAMES,
  SETTINGS_LEAVES,
} from "./schema.js";

/** Which layer supplied a value (lowest → highest precedence). */
export type LayerName = "default" | "user" | "project" | "local" | "env" | "override";

export interface ProvenanceEntry {
  readonly layer: LayerName;
  /** Absolute file path or env var name; absent for defaults and overrides. */
  readonly source?: string;
  /**
   * R9.6 — the dotted key actually present in the source, when it differs from
   * the leaf this value landed on (i.e. the file still names a renamed setting).
   * Absent in the ordinary case. Reporting the new key here would claim the file
   * says something it does not, which is the dishonesty the migration exists to
   * avoid: the user must be able to find the line they need to edit.
   */
  readonly key?: string;
}

/** Dotted `section.key` → which layer supplied the effective value. */
export type Provenance = Readonly<Record<string, ProvenanceEntry>>;

/** Per-request override layer: same snake_case two-level shape as the files. */
export type SettingsOverrides = {
  readonly [S in keyof GolemSettings]?: Partial<GolemSettings[S]>;
};

export interface LoadConfigOptions {
  /** Project root containing `.golem/`; defaults to process.cwd(). */
  readonly projectDir?: string;
  /** User config dir; defaults to `~/.golem` (see paths.ts). */
  readonly userDir?: string;
  /** Environment to read `GOLEM_*` overrides from; defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Highest-precedence in-memory layer (e.g. per-request header overrides). */
  readonly overrides?: SettingsOverrides;
}

export interface GolemConfig {
  /** Effective settings, deeply frozen. */
  readonly settings: GolemSettings;
  /** Which layer supplied each `section.key` (for `golem status`). */
  readonly provenance: Provenance;
  /** Resolved settings file paths (whether or not the files exist). */
  readonly files: SettingsFilePaths;
  /** Non-fatal issues: unknown keys/sections, unrecognized GOLEM_* vars. */
  readonly warnings: readonly string[];
}

type MutableTree = Record<string, Record<string, unknown>>;

export async function loadConfig(options: LoadConfigOptions = {}): Promise<GolemConfig> {
  const files = settingsFilePaths(options);

  // Layer 0: defaults.
  const tree: MutableTree = {};
  const provenance: Record<string, ProvenanceEntry> = {};
  for (const section of SECTION_NAMES) {
    tree[section] = {
      ...(DEFAULT_SETTINGS[section] as unknown as Record<string, unknown>),
    };
    for (const key of Object.keys(SETTINGS_LEAVES[section])) {
      provenance[`${section}.${key}`] = { layer: "default" };
    }
  }

  const warnings: string[] = [];

  // Layers 1–3: settings files.
  const fileLayers: readonly { readonly layer: LayerName; readonly file: string }[] = [
    { layer: "user", file: files.user },
    { layer: "project", file: files.project },
    { layer: "local", file: files.local },
  ];
  for (const { layer, file } of fileLayers) {
    const raw = await readSettingsFile(file);
    if (raw !== undefined) {
      applyObjectLayer(tree, provenance, warnings, raw, layer, file);
    }
  }

  // Layer 4: environment.
  const envLayer = readEnvLayer(options.env ?? process.env);
  warnings.push(...envLayer.warnings);
  for (const override of envLayer.overrides) {
    const section = tree[override.section];
    if (section !== undefined) {
      section[override.key] = override.value;
      provenance[`${override.section}.${override.key}`] = {
        layer: "env",
        source: override.varName,
      };
    }
  }

  // Layer 5: per-request overrides.
  if (options.overrides !== undefined) {
    applyObjectLayer(tree, provenance, warnings, options.overrides, "override", undefined);
  }

  const settings = deepFreeze(tree as unknown as GolemSettings);
  return deepFreeze({
    settings,
    provenance: provenance as Provenance,
    files,
    warnings,
  });
}

/**
 * Read + parse one settings file. Returns undefined when the file is missing
 * or effectively empty; throws ConfigError (naming the file) on unreadable
 * files or malformed JSON.
 */
async function readSettingsFile(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new ConfigError(
      `cannot read settings file ${file}: ${err instanceof Error ? err.message : String(err)}`,
      { source: file },
    );
  }
  // Windows editors may prepend a UTF-8 BOM; JSON.parse rejects it.
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (stripped.trim() === "") {
    return undefined;
  }
  try {
    return JSON.parse(stripped);
  } catch (err) {
    throw new ConfigError(
      `settings file ${file} contains invalid JSON: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      { source: file },
    );
  }
}

/**
 * Leaves that merge PER KEY across layers instead of replacing wholesale.
 *
 * The default — a whole leaf replaced by the highest layer that sets it — is
 * right for a scalar and for a list. It is wrong for a registry keyed by
 * user-chosen ids: a project that declares a bench would silently erase the
 * user's, and restaffing one persona in `settings.local.json` would mean
 * restating every other persona to avoid losing them.
 *
 * Membership is deliberately a short, explicit list rather than "any
 * `z.record` leaf". `inference.worker_targets` is also a record and is NOT
 * here: replacing a target map wholesale is the long-standing behaviour, and
 * changing it silently would be a routing change disguised as a refactor.
 */
const MERGE_PER_KEY_LEAVES: ReadonlySet<string> = new Set(["inference.personas"]);

/**
 * Merge one layer's record-of-objects onto what lower layers built: per key,
 * then per field within a key.
 *
 * Two levels, not a general deep merge. One level would make
 * `{ "reviewer": { "model": "..." } }` in `settings.local.json` drop the
 * project's `discipline` and `description` for that persona, which is exactly
 * the case this exists to serve. Going deeper than two has no meaning here —
 * a persona's fields are scalars and one string array, and `tools` REPLACES
 * (an allow-list you can only add to is not an allow-list).
 *
 * Provenance is recorded per `<leaf>.<id>.<field>` so `golem personas` can say
 * which layer supplied each field, not merely which layer last touched the
 * bench.
 */
function mergePerKey(
  previous: unknown,
  incoming: Record<string, unknown>,
  dotted: string,
  provenance: Record<string, ProvenanceEntry>,
  layer: LayerName,
  sourceFile: string | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = isPlainObject(previous) ? { ...previous } : {};
  for (const [id, value] of Object.entries(incoming)) {
    if (!isPlainObject(value)) {
      merged[id] = value;
      continue;
    }
    const prior = merged[id];
    merged[id] = isPlainObject(prior) ? { ...prior, ...value } : { ...value };
    for (const field of Object.keys(value)) {
      provenance[`${dotted}.${id}.${field}`] = {
        layer,
        ...(sourceFile !== undefined && { source: sourceFile }),
      };
    }
  }
  return merged;
}

/**
 * Apply one object-shaped layer (file contents or per-request overrides) to
 * the merge tree, recording provenance and collecting unknown-key warnings.
 */
function applyObjectLayer(
  tree: MutableTree,
  provenance: Record<string, ProvenanceEntry>,
  warnings: string[],
  raw: unknown,
  layer: LayerName,
  sourceFile: string | undefined,
): void {
  const label = sourceFile ?? "per-request overrides";
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${label}: settings root must be a JSON object`, {
      ...(sourceFile !== undefined && { source: sourceFile }),
    });
  }
  for (const [sectionName, sectionValue] of Object.entries(raw)) {
    if (!(sectionName in SETTINGS_LEAVES)) {
      warnings.push(`${label}: unknown settings section "${sectionName}" ignored`);
      continue;
    }
    if (!isPlainObject(sectionValue)) {
      throw new ConfigError(
        `${label}: section "${sectionName}" must be an object of settings, ` +
          `got ${describeType(sectionValue)}`,
        { key: sectionName, ...(sourceFile !== undefined && { source: sourceFile }) },
      );
    }
    for (const [key, value] of Object.entries(sectionValue)) {
      const dotted = `${sectionName}.${key}`;
      let leaf = leafSchema(sectionName, key);
      // R9.6: the key the value lands on, and the key the FILE named — the same
      // thing except for a renamed setting, where provenance must report the
      // name actually present in the file rather than implying the new one.
      let targetKey = key;
      let fromKey: string | undefined;

      if (leaf === undefined) {
        // A RETIRED key raises before anything else. It is not unknown (we know
        // exactly what it was) and it is not renamed (there is no destination
        // leaf), so neither of the branches below would tell the truth about it.
        const retired = retirementFor(dotted);
        if (retired !== undefined) {
          throw new ConfigError(retirementMessage(retired, label), {
            key: dotted,
            ...(sourceFile !== undefined && { source: sourceFile }),
          });
        }
        const migration = migrationFrom(dotted);
        if (migration === undefined) {
          warnings.push(`${label}: unknown setting "${dotted}" ignored`);
          continue;
        }
        // The replacement set in the SAME layer wins; the old key is reported
        // and dropped. Across layers, normal precedence applies untouched.
        const [, liveKey] = splitDotted(migration.to);
        if (liveKey !== undefined && Object.hasOwn(sectionValue, liveKey)) {
          warnings.push(migrationShadowedWarning(migration, label));
          continue;
        }
        // Exactly one warning per migrated key — never also "unknown setting".
        warnings.push(migrationWarning(migration, label));
        targetKey = liveKey ?? key;
        fromKey = dotted;
        leaf = leafSchema(sectionName, targetKey);
        if (leaf === undefined) continue; // guarded by assertLeafRename's test
      }

      if (value === undefined) {
        continue; // absent — only possible via in-memory overrides
      }
      const parsed = leaf.safeParse(value);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => i.message).join("; ");
        throw new ConfigError(`${label}: invalid value for "${dotted}": ${issues}`, {
          key: dotted,
          ...(sourceFile !== undefined && { source: sourceFile }),
        });
      }
      const section = tree[sectionName];
      if (section !== undefined) {
        section[targetKey] = MERGE_PER_KEY_LEAVES.has(dotted)
          ? mergePerKey(
              section[targetKey],
              parsed.data as Record<string, unknown>,
              dotted,
              provenance,
              layer,
              sourceFile,
            )
          : parsed.data;
        provenance[`${sectionName}.${targetKey}`] = {
          layer,
          ...(sourceFile !== undefined && { source: sourceFile }),
          ...(fromKey !== undefined && { key: fromKey }),
        };
      }
    }
  }
}

function describeType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}
