/**
 * R8.11 — resolving and loading declared plugins (ADR-0004 §3).
 *
 * The rule Decision 53 fixed in advance: **Golem ships none of a plugin's
 * bytes.** So this module resolves what the user already installed and does
 * nothing else — no download, no install, no version fetch, no auto-update. A
 * declared plugin that is not installed is not an error; it is a row in
 * `golem plugin list` saying `unresolved`, and Golem runs exactly as it did
 * before (admission criterion 3).
 *
 * Enabling is per plugin AND per seam. Listing a package under
 * `plugins.entries` grants nothing on its own — `seams: ["redaction"]` grants
 * exactly the redaction seam, and a plugin offering a stage it was not granted
 * has that stage ignored and said so. Installing a package is not consent;
 * naming its seam is.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  GolemPlugin,
  PluginLoadFailure,
  PluginSeam,
  PluginStage,
  PluginTool,
} from "../interfaces/plugin.js";
import type { RedactionRule } from "../pipeline/redaction-rules.js";
import { pluginLog } from "./quarantine.js";
import { compileRedactionRules, type RejectedRule } from "./redaction-rules.js";

/** One `plugins.entries` row, as it appears in settings. */
export interface PluginEntry {
  readonly id: string;
  /** npm package name or a path (absolute, or relative to the project dir). */
  readonly specifier: string;
  /** Exact version this deployment expects. Compared, never fetched. */
  readonly pin?: string;
  /** Which seams this plugin may contribute. Empty or absent → none. */
  readonly seams?: readonly PluginSeam[];
}

/** What a declared plugin turned into. One row per entry, always. */
export interface LoadedPlugin {
  /** The configured id (not the plugin's self-reported name). */
  readonly id: string;
  readonly specifier: string;
  readonly pin?: string;
  readonly seams: readonly PluginSeam[];
  /** Resolved absolute path, when resolution succeeded. */
  readonly resolvedPath?: string;
  /** The plugin's self-reported name, namespacing its rules and tools. */
  readonly name?: string;
  /** The plugin's self-reported version, for comparison against `pin`. */
  readonly version?: string;
  /** Why it contributed nothing. Absent when it loaded. */
  readonly failure?: PluginLoadFailure;
  /** Human-readable detail for the failure, or a note about a partial load. */
  readonly detail?: string;
  readonly redactionRules: readonly RedactionRule[];
  readonly rejectedRules: readonly RejectedRule[];
  readonly stage?: PluginStage;
  readonly tools: readonly PluginTool[];
}

export interface LoadResult {
  readonly plugins: readonly LoadedPlugin[];
}

const EMPTY = { redactionRules: [], rejectedRules: [], tools: [] } as const;

function isGolemPlugin(value: unknown): value is GolemPlugin {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    (value as { name: string }).name.length > 0
  );
}

/**
 * Resolve a specifier to an absolute path without importing it. A path (`.`,
 * `..`, absolute, or anything with a separator) resolves against the project
 * dir; anything else is treated as an npm package and resolved through Node's
 * own algorithm from the project dir, so it finds what the **user** installed
 * rather than what Golem depends on.
 */
function resolveSpecifier(projectDir: string, specifier: string): string | null {
  // `./x`, `../x` or an absolute path (both separators, since a Windows user
  // writes `D:\plugins\x.js` and a settings file copied from macOS says `/opt/x.js`).
  const looksLikePath = specifier.startsWith(".") || path.isAbsolute(specifier);
  try {
    if (looksLikePath) {
      return path.resolve(projectDir, specifier);
    }
    // createRequire rooted in the project so resolution walks the USER's
    // node_modules, not Golem's own install tree.
    const req = createRequire(path.join(projectDir, "package.json"));
    return req.resolve(specifier);
  } catch {
    return null;
  }
}

/** Load one entry. Never throws — every failure becomes a described row. */
export async function loadPlugin(projectDir: string, entry: PluginEntry): Promise<LoadedPlugin> {
  const seams = entry.seams ?? [];
  const base = { id: entry.id, specifier: entry.specifier, seams, ...EMPTY } as const;
  const withPin = entry.pin !== undefined ? { ...base, pin: entry.pin } : base;

  if (seams.length === 0) {
    return {
      ...withPin,
      failure: "no-seams-enabled",
      detail: 'no seams granted — add e.g. `"seams": ["redaction"]` to the entry',
    };
  }

  const resolvedPath = resolveSpecifier(projectDir, entry.specifier);
  if (resolvedPath === null) {
    return {
      ...withPin,
      failure: "unresolved",
      detail: `Golem never installs a plugin — run your own \`npm install ${entry.specifier}\`, or point \`specifier\` at a local path`,
    };
  }

  let imported: unknown;
  try {
    imported = await import(pathToFileURL(resolvedPath).href);
  } catch (error) {
    return {
      ...withPin,
      resolvedPath,
      failure: "import-failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const exported = (imported as { default?: unknown }).default ?? imported;
  if (!isGolemPlugin(exported)) {
    return {
      ...withPin,
      resolvedPath,
      failure: "invalid-export",
      detail: "default export is not a GolemPlugin (needs at least a non-empty `name`)",
    };
  }

  const found = { ...withPin, resolvedPath, name: exported.name } as LoadedPlugin;
  const version = exported.version;

  // The pin is COMPARED, never enforced by fetching. Golem does not install, so
  // a mismatch is the user's to resolve — Golem's job is to refuse to run code
  // the deployment did not pin, and to say which version it actually found.
  if (entry.pin !== undefined && version !== entry.pin) {
    return {
      ...found,
      ...(version !== undefined ? { version } : {}),
      failure: "pin-mismatch",
      detail: `pinned ${entry.pin}, installed ${version ?? "unknown"} — contributing nothing`,
    };
  }

  const notes: string[] = [];
  let redactionRules: readonly RedactionRule[] = [];
  let rejectedRules: readonly RejectedRule[] = [];
  if (exported.redactionRules !== undefined && exported.redactionRules.length > 0) {
    if (seams.includes("redaction")) {
      const compiled = compileRedactionRules(exported.name, exported.redactionRules);
      redactionRules = compiled.rules;
      rejectedRules = compiled.rejected;
      for (const rule of compiled.rejected) {
        pluginLog(exported.name, `redaction rule ${rule.id} rejected: ${rule.reason}`);
      }
    } else {
      notes.push(
        `offers ${exported.redactionRules.length} redaction rule(s) but that seam is not granted`,
      );
    }
  }

  let stage: PluginStage | undefined;
  if (exported.stage !== undefined) {
    if (seams.includes("stage")) {
      stage = exported.stage;
    } else {
      notes.push("offers a pipeline stage but that seam is not granted");
    }
  }

  let tools: readonly PluginTool[] = [];
  if (exported.tools !== undefined && exported.tools.length > 0) {
    if (seams.includes("tool")) {
      tools = exported.tools;
    } else {
      notes.push(`offers ${exported.tools.length} tool(s) but that seam is not granted`);
    }
  }

  return {
    ...found,
    ...(version !== undefined ? { version } : {}),
    redactionRules,
    rejectedRules,
    ...(stage !== undefined ? { stage } : {}),
    tools,
    ...(notes.length > 0 ? { detail: notes.join("; ") } : {}),
  };
}

/**
 * Load every declared entry, in declaration order. Order matters: it fixes the
 * order plugin redaction rules are applied in, and an unstable order would make
 * placeholder numbering unstable, which would break prefix stability (§14).
 */
export async function loadPlugins(
  projectDir: string,
  entries: readonly PluginEntry[],
): Promise<LoadResult> {
  const plugins: LoadedPlugin[] = [];
  for (const entry of entries) {
    plugins.push(await loadPlugin(projectDir, entry));
  }
  return { plugins };
}

/** Every compiled rule from every loaded plugin, in declaration order. */
export function collectRedactionRules(result: LoadResult): readonly RedactionRule[] {
  return result.plugins.flatMap((plugin) => plugin.redactionRules);
}
