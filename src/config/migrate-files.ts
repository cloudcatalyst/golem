/**
 * R9.13 — fix the settings files, not just the read of them.
 *
 * R9.6 made a renamed setting keep working: the loader redirects a retired key
 * to its replacement and warns (`src/config/loader.ts:222-241`). What it
 * deliberately did not do is rewrite the file, so adoption was manual — a
 * project that upgraded kept its retired keys, and kept the warning, until a
 * human ran `golem config set`. This module closes that loop.
 *
 * **The version stamp is not load-bearing.** The trigger for a rewrite is the
 * *presence of a retired key*; the stamp only decides when to bother looking. A
 * missing, stale or wrong stamp therefore degrades to "scanned more or less
 * often than needed" — never to a bad rewrite. Do not guard it as if the
 * correctness of a migration depended on it.
 *
 * Three things this does NOT do, each on purpose:
 * - **Never clobber a file it cannot parse.** Malformed JSON is reported and
 *   left exactly as it is, matching `readExisting`'s stance in write-setting.ts.
 * - **Never move a key.** A rename happens *in position*, because
 *   `.golem/settings.json` is committed and a key that jumps to the end of its
 *   section turns a one-line diff into a whole-section one.
 * - **Never throw at the caller.** Per-file problems come back as `error`
 *   strings; a settings sweep must not be able to stop a proxy from starting.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isPlainObject, splitDotted, writeAtomic } from "./file-io.js";
import { SETTING_MIGRATIONS } from "./migrations.js";
import { PROJECT_DIR_NAME, settingsFilePaths } from "./paths.js";
import type { SettingsScope } from "./write-setting.js";

/** Lowest layer first, so the report reads in precedence order. */
const SCOPES: readonly SettingsScope[] = ["user", "project", "local"];

/** One retired key this sweep dealt with, and how. */
export interface SettingChange {
  readonly from: string;
  readonly to: string;
  /** Task or release that renamed it, quoted in the report so it is traceable. */
  readonly since: string;
  /**
   * `renamed` — the file held only the retired key, so it now holds the live one
   * with the same value. `dropped` — the file held both, so the retired one was
   * removed; the loader was already ignoring it (see its shadowed-key branch).
   */
  readonly action: "renamed" | "dropped";
}

/** What happened to one scope's settings file. */
export interface ScopeResult {
  readonly scope: SettingsScope;
  readonly file: string;
  readonly changes: readonly SettingChange[];
  /** Where the pre-migration copy was saved. Absent in check mode. */
  readonly backup?: string;
  /** Why this file was left alone. Present only when nothing was written. */
  readonly error?: string;
}

export interface MigrationSweep {
  /** Only files that needed something, or could not be read. Clean files are silent. */
  readonly results: readonly ScopeResult[];
  /** True when at least one file holds a retired key (applied, or applicable). */
  readonly changed: boolean;
}

export interface SweepOptions {
  readonly projectDir: string;
  readonly userDir?: string;
  /** False computes the report and touches nothing. */
  readonly write: boolean;
  /** Golem version, used to name the backup file. */
  readonly version: string;
}

/**
 * Copy `section` with `from` renamed to `to` **at its original position**.
 *
 * `delete` + assign would be shorter and would move the key to the end, since
 * JSON key order is insertion order. That is the whole reason this exists.
 */
function renameKeyInPlace(
  section: Record<string, unknown>,
  from: string,
  to: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(section)) {
    if (key === from) out[to] = value;
    else out[key] = value;
  }
  return out;
}

function withoutKey(section: Record<string, unknown>, key: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...section };
  delete out[key];
  return out;
}

interface ParsedFile {
  readonly root: Record<string, unknown>;
  readonly indent: string;
  readonly trailingNewline: boolean;
  readonly original: string;
}

/**
 * Read and parse one settings file.
 *
 * Returns `null` when there is nothing to migrate (absent or blank) and a string
 * when the file exists but must be left alone.
 */
async function parseFile(file: string): Promise<ParsedFile | null | string> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return `cannot read it (${err instanceof Error ? err.message : String(err)})`;
  }
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (stripped.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    return `it contains invalid JSON (${err instanceof Error ? err.message : String(err)})`;
  }
  if (!isPlainObject(parsed)) return "its root is not a JSON object";
  return {
    root: parsed,
    indent: stripped.match(/\n([ \t]+)\S/)?.[1] ?? "  ",
    trailingNewline: stripped.endsWith("\n"),
    original: text,
  };
}

/** Apply every migration to a parsed root, returning the new root and what changed. */
function migrateRoot(root: Record<string, unknown>): {
  readonly root: Record<string, unknown>;
  readonly changes: readonly SettingChange[];
} {
  const next: Record<string, unknown> = { ...root };
  const changes: SettingChange[] = [];

  for (const migration of SETTING_MIGRATIONS) {
    const [section, fromLeaf] = splitDotted(migration.from);
    const [, toLeaf] = splitDotted(migration.to);
    if (fromLeaf === undefined || toLeaf === undefined) continue;

    const sectionValue = next[section];
    if (!isPlainObject(sectionValue)) continue;
    if (!Object.hasOwn(sectionValue, fromLeaf)) continue;

    if (Object.hasOwn(sectionValue, toLeaf)) {
      // The loader already ignores the retired key here; the file catches up.
      next[section] = withoutKey(sectionValue, fromLeaf);
      changes.push({ ...migration, action: "dropped" });
    } else {
      next[section] = renameKeyInPlace(sectionValue, fromLeaf, toLeaf);
      changes.push({ ...migration, action: "renamed" });
    }
  }
  return { root: next, changes };
}

/** `<project>/.golem/state/config-backups/<scope>-<version>.json`. */
export function backupPath(projectDir: string, scope: SettingsScope, version: string): string {
  // Gitignored by the `**/.golem/state/**` rule `golem init` writes — deliberately
  // NOT a `settings.json.bak` alongside the original, which would surface as an
  // untracked file in the user's repository.
  const safeVersion = version.replace(/[^\w.-]/g, "_");
  return path.join(
    projectDir,
    PROJECT_DIR_NAME,
    "state",
    "config-backups",
    `${scope}-${safeVersion}.json`,
  );
}

/**
 * Rewrite retired setting keys to their live names across all three scopes.
 *
 * Files that need nothing produce no result at all — a sweep over a clean
 * project is silent, which is what makes it safe to run on every proxy start.
 */
export async function sweepSettingsFiles(options: SweepOptions): Promise<MigrationSweep> {
  const files = settingsFilePaths({
    projectDir: options.projectDir,
    ...(options.userDir !== undefined && { userDir: options.userDir }),
  });
  const results: ScopeResult[] = [];

  for (const scope of SCOPES) {
    const file = files[scope];
    const parsed = await parseFile(file);
    if (parsed === null) continue;
    if (typeof parsed === "string") {
      results.push({ scope, file, changes: [], error: parsed });
      continue;
    }

    const { root, changes } = migrateRoot(parsed.root);
    if (changes.length === 0) continue;
    if (!options.write) {
      results.push({ scope, file, changes });
      continue;
    }

    const text = JSON.stringify(root, null, parsed.indent) + (parsed.trailingNewline ? "\n" : "");
    const backup = backupPath(options.projectDir, scope, options.version);
    try {
      // Backup first: if this fails, the original is still the only copy on disk
      // and the rewrite has not happened.
      await mkdir(path.dirname(backup), { recursive: true });
      await writeFile(backup, parsed.original, "utf8");
      await writeAtomic(file, text);
      results.push({ scope, file, changes, backup });
    } catch (err) {
      results.push({
        scope,
        file,
        changes: [],
        error: `could not be rewritten (${err instanceof Error ? err.message : String(err)})`,
      });
    }
  }

  return { results, changed: results.some((r) => r.changes.length > 0) };
}

/**
 * Human lines for a sweep — one per change, one per backup, one per error.
 *
 * The chosen posture rewrites a *committed* file without asking. That is only
 * defensible if the resulting diff is explained, so this report is not
 * decoration: it is the other half of the trade.
 */
export function renderSweep(sweep: MigrationSweep, write: boolean): string[] {
  const lines: string[] = [];
  for (const result of sweep.results) {
    if (result.error !== undefined) {
      lines.push(`${result.file}: NOT migrated — ${result.error}`);
      continue;
    }
    for (const change of result.changes) {
      const verb =
        change.action === "renamed"
          ? write
            ? `renamed "${change.from}" → "${change.to}"`
            : `would rename "${change.from}" → "${change.to}"`
          : write
            ? `dropped "${change.from}" — "${change.to}" is set here and already won`
            : `would drop "${change.from}" — "${change.to}" is set here and already wins`;
      lines.push(`${result.file}: ${verb} (renamed in ${change.since})`);
    }
    if (result.backup !== undefined) {
      lines.push(`${result.file}: previous contents saved to ${result.backup}`);
    }
  }
  if (!write && sweep.changed) {
    lines.push("Nothing was written. Run `golem config migrate --write` to apply.");
  }
  return lines;
}

/** `<project>/.golem/state/version.json` — the version this project last ran. */
export function versionStampPath(projectDir: string): string {
  return path.join(projectDir, PROJECT_DIR_NAME, "state", "version.json");
}

/** The stamped version, or null when there is none (or it is unreadable). */
export async function readVersionStamp(projectDir: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(versionStampPath(projectDir), "utf8"));
    if (!isPlainObject(parsed)) return null;
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null; // absent or corrupt: treat as "never seen", i.e. scan.
  }
}

export async function writeVersionStamp(projectDir: string, version: string): Promise<void> {
  const file = versionStampPath(projectDir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ version }, null, 2)}\n`, "utf8");
}

/**
 * Remove the stamp (uninit). The backups under `config-backups/` stay: they are
 * copies of the user's own settings, not Golem's bookkeeping.
 */
export async function removeVersionStamp(projectDir: string): Promise<void> {
  await rm(versionStampPath(projectDir), { force: true });
}

export interface VersionMigrationOutcome {
  /** True when the version changed and the sweep ran. */
  readonly ran: boolean;
  /** The version stamped before this run; null on a project that has none. */
  readonly previous: string | null;
  /** Report lines, empty when there was nothing to say. */
  readonly lines: readonly string[];
}

/**
 * The automatic path: on the first run under a new version, fix every scope.
 *
 * Best-effort by construction. Every failure mode — no `.golem/` directory, an
 * unwritable stamp, a malformed settings file — returns quietly instead of
 * throwing, because the callers are `golem proxy` starting up and `golem init`,
 * and neither should be stoppable by settings bookkeeping.
 */
export async function migrateOnVersionChange(options: {
  readonly projectDir: string;
  readonly userDir?: string;
  readonly version: string;
}): Promise<VersionMigrationOutcome> {
  // An uninitialized directory is not a Golem project; do not create state in it.
  if (!existsSync(path.join(options.projectDir, PROJECT_DIR_NAME))) {
    return { ran: false, previous: null, lines: [] };
  }
  try {
    const previous = await readVersionStamp(options.projectDir);
    if (previous === options.version) return { ran: false, previous, lines: [] };

    const sweep = await sweepSettingsFiles({
      projectDir: options.projectDir,
      ...(options.userDir !== undefined && { userDir: options.userDir }),
      write: true,
      version: options.version,
    });
    await writeVersionStamp(options.projectDir, options.version).catch(() => {});
    return { ran: true, previous, lines: renderSweep(sweep, true) };
  } catch {
    return { ran: false, previous: null, lines: [] };
  }
}
