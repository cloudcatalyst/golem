/**
 * R9.16 — is the VS Code extension we shipped the one that is actually running?
 *
 * The bug that produced this module: the status bar named `qwen2.5-coder:7b` as
 * the coder's model while the CLI correctly named `claude-sonnet-5`. The config
 * was right, the CLI was right, and the *deployed* `render.js` was three
 * releases behind — it read the worker list from `st.local_model.workers` while
 * the CLI had moved it to the top level, so it found none and fell back to the
 * local model. A surface confidently naming a model nobody was using is the
 * R8.32/R9.4 failure class, arriving through a new door.
 *
 * The repo copy had been correct the whole time. It had never been deployed,
 * because `init` keyed on the target DIRECTORY existing — and that directory is
 * named for the extension version, so shipping a fix without bumping the version
 * made every later `golem init` a silent no-op. R9.5's seed-once bug, one level
 * up, in the one place R9.5 did not look.
 *
 * **No ownership check here, unlike R9.5.** `.claude/rules/*.md` and `SKILL.md`
 * are documents a user may legitimately edit, so R9.5 refuses to overwrite what
 * it cannot prove it wrote. The deployed extension is a build artifact in VS
 * Code's own directory; nobody hand-edits `render.js` there. "Differs from what
 * we ship" therefore means *stale*, and refreshing it loses nothing.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Runtime files that constitute the installed extension (no tests/tooling). */
export const VSCODE_EXTENSION_FILES = [
  "extension.js",
  "render.js",
  "package.json",
  "README.md",
  "media",
] as const;

/** Where this package's bundled extension lives (dist/cli/… → ../../vscode-extension). */
export function defaultVscodeSourceDir(): string {
  return fileURLToPath(new URL("../../vscode-extension", import.meta.url));
}

/** VS Code's global extensions directory for this user. */
export function defaultVscodeExtensionsDir(home: string = os.homedir()): string {
  return path.join(home, ".vscode", "extensions");
}

/**
 * How the deployed copy relates to the one we ship.
 *
 * `unknown` is distinct from `absent` on purpose: no VS Code on this machine, or
 * no bundled source to compare against, is not the same as "installed and
 * missing", and only one of the three is worth telling anybody about.
 */
export type VscodeExtensionState = "current" | "stale" | "absent" | "unknown";

export interface VscodeExtensionReport {
  readonly state: VscodeExtensionState;
  /** Extension id (`publisher.name-version`), when the manifest could be read. */
  readonly id?: string;
  /** Absolute path of the deployed directory, when one is expected. */
  readonly dir?: string;
  /** Deployed files that differ from what we ship — empty unless `stale`. */
  readonly staleFiles: readonly string[];
}

export interface InspectOptions {
  /** Bundled source; defaults to the one shipped beside this module. */
  readonly sourceDir?: string;
  /** VS Code extensions dir, or null when VS Code is absent. Tests inject. */
  readonly extensionsDir?: string | null;
}

/** sha256 of a file's bytes, or null when it is unreadable. */
async function hashFile(file: string): Promise<string | null> {
  try {
    return createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  } catch {
    return null;
  }
}

/**
 * A stable digest of one entry, file or directory.
 *
 * Directories (`media`) are digested from their sorted relative paths plus each
 * file's hash, so an added, removed or edited asset all register. Sorted because
 * readdir order is not a promise anyone made.
 */
async function hashEntry(entry: string): Promise<string | null> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(entry);
  } catch {
    return null;
  }
  if (info.isFile()) return await hashFile(entry);
  if (!info.isDirectory()) return null;

  const names = (await readdir(entry, { withFileTypes: true, recursive: true }))
    .filter((d) => d.isFile())
    .map((d) => path.join(d.parentPath ?? entry, d.name))
    .sort();
  const digest = createHash("sha256");
  for (const file of names) {
    digest.update(path.relative(entry, file).split(path.sep).join("/"));
    digest.update(String(await hashFile(file)));
  }
  return digest.digest("hex");
}

/**
 * Compare the shipped extension with the deployed one.
 *
 * Hashes rather than mtimes: a redeploy that copies identical bytes must not
 * read as a change, and a file restored from a backup with an old timestamp must
 * not read as current.
 */
export async function inspectVscodeExtension(
  options: InspectOptions = {},
): Promise<VscodeExtensionReport> {
  const extensionsDir =
    options.extensionsDir === undefined ? defaultVscodeExtensionsDir() : options.extensionsDir;
  if (extensionsDir === null) return { state: "unknown", staleFiles: [] };
  try {
    await stat(extensionsDir);
  } catch {
    return { state: "unknown", staleFiles: [] }; // no VS Code on this machine
  }

  const sourceDir = options.sourceDir ?? defaultVscodeSourceDir();
  let manifest: { publisher?: unknown; name?: unknown; version?: unknown };
  try {
    manifest = JSON.parse(await readFile(path.join(sourceDir, "package.json"), "utf8"));
  } catch {
    return { state: "unknown", staleFiles: [] }; // source not shipped in this install
  }
  const id = `${String(manifest.publisher)}.${String(manifest.name)}-${String(manifest.version)}`;
  const dir = path.join(extensionsDir, id);

  try {
    await stat(dir);
  } catch {
    return { state: "absent", id, dir, staleFiles: [] };
  }

  const staleFiles: string[] = [];
  for (const name of VSCODE_EXTENSION_FILES) {
    const shipped = await hashEntry(path.join(sourceDir, name));
    if (shipped === null) continue; // not part of this build; nothing to compare
    if (shipped !== (await hashEntry(path.join(dir, name)))) staleFiles.push(name);
  }
  return {
    state: staleFiles.length === 0 ? "current" : "stale",
    id,
    dir,
    staleFiles,
  };
}

/**
 * The sentence `golem status` shows for a stale deployment.
 *
 * Names the files, because "the extension is stale" invites the reply "says
 * who?" — and names the fix, because a warning nobody can act on is the same as
 * no warning (R9.6).
 */
export function staleExtensionWarning(report: VscodeExtensionReport): string {
  return (
    `the installed VS Code extension is older than the one this Golem ships ` +
    `(${report.staleFiles.join(", ")} differ). Its panel and status bar may name ` +
    "models or settings that are no longer accurate — run `golem init`, then " +
    "reload the VS Code window (Developer: Reload Window)."
  );
}
