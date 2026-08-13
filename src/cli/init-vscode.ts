/**
 * The VS Code half of `golem init` / `golem uninit`.
 *
 * Two things, both scoped to VS Code and neither of interest to the rest of
 * init: the workspace `files.watcherExclude` entries that stop the Source
 * Control icon flashing on Golem's gitignored runtime writes, and the install
 * and removal of the bundled panel + status-bar extension.
 *
 * It lives next to `vscode-extension.ts` — which owns what the extension IS and
 * where it lives — rather than in init.ts, so the two cannot drift apart.
 *
 * Each function returns an {@link InitAction} for init's report rather than
 * printing anything, and each add/remove pair is an exact inverse: change one
 * half and you must change the other, or `golem uninit` stops undoing what
 * `golem init` did.
 *
 * The `InitAction`/`InitOptions`/`UninitOptions` imports are type-only, so they
 * are erased at build time and create no runtime cycle back to init.ts.
 */

import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { InitAction, InitOptions, UninitOptions } from "./init.js";
import { defaultProbe } from "./init.js";
import {
  type JsonObject,
  objectEntry,
  pathExists,
  readJsonObject,
  rel,
  writeJsonObject,
} from "./json-file.js";
import {
  defaultVscodeSourceDir,
  inspectVscodeExtension,
  VSCODE_EXTENSION_FILES,
} from "./vscode-extension.js";

/**
 * Golem's own gitignored runtime dirs that churn constantly while a proxy is
 * running (telemetry event log, statusline/dashboard state, webcache, CCR
 * store, knowledge index, notes, distill drafts). VS Code's git extension
 * recomputes repo status on any watched filesystem event — including
 * gitignored ones, since `files.watcherExclude` only excludes `.git`/
 * `node_modules` by default — so these writes make the Source Control sync
 * icon flash continuously. Excluding them from the workspace file watcher is
 * cosmetic (nothing here is ever committed) but stops the noise.
 */
const VSCODE_WATCHER_EXCLUDE_DIRS = [
  "**/.golem/telemetry/**",
  "**/.golem/state/**",
  "**/.golem/webcache/**",
  "**/.golem/ccr/**",
  "**/.golem/knowledge/**",
  "**/.golem/notes/**",
  "**/.golem/distill/**",
] as const;
const VSCODE_WATCHER_EXCLUDE_KEY = "files.watcherExclude";

/**
 * Idempotently add Golem's churny runtime dirs to `.vscode/settings.json`'s
 * `files.watcherExclude` (workspace-scoped, so it applies whether or not the
 * Golem VS Code extension itself is installed). Never removes or overwrites
 * unrelated keys or other watcherExclude entries the user already has.
 */
export async function ensureVscodeWatcherExclude(
  projectDir: string,
  dryRun: boolean,
): Promise<InitAction> {
  const file = path.join(projectDir, ".vscode", "settings.json");
  const existing = await readJsonObject(file);
  const settings = existing ?? {};
  const watcherExclude = objectEntry(settings, VSCODE_WATCHER_EXCLUDE_KEY);

  let changed = false;
  for (const pattern of VSCODE_WATCHER_EXCLUDE_DIRS) {
    if (watcherExclude[pattern] !== true) {
      watcherExclude[pattern] = true;
      changed = true;
    }
  }

  const relPath = rel(projectDir, file);
  if (!changed) {
    return { kind: "skip", path: relPath, detail: "watcher excludes already set" };
  }
  if (!dryRun) await writeJsonObject(file, settings);
  return {
    kind: existing === null ? "create" : "modify",
    path: relPath,
    detail: "exclude Golem's runtime dirs from the file watcher",
  };
}

/** The removal half of {@link ensureVscodeWatcherExclude} — only ever deletes entries init added. */
export async function removeVscodeWatcherExclude(
  projectDir: string,
  dryRun: boolean,
): Promise<InitAction> {
  const file = path.join(projectDir, ".vscode", "settings.json");
  const relPath = rel(projectDir, file);
  const settings = await readJsonObject(file);
  const watcherExclude = settings?.[VSCODE_WATCHER_EXCLUDE_KEY];
  if (
    settings === null ||
    typeof watcherExclude !== "object" ||
    watcherExclude === null ||
    Array.isArray(watcherExclude)
  ) {
    return { kind: "skip", path: relPath, detail: "not present" };
  }
  const watcherExcludeObj = watcherExclude as JsonObject;
  let changed = false;
  for (const pattern of VSCODE_WATCHER_EXCLUDE_DIRS) {
    if (watcherExcludeObj[pattern] === true) {
      delete watcherExcludeObj[pattern];
      changed = true;
    }
  }
  if (!changed) return { kind: "skip", path: relPath, detail: "not present" };
  if (Object.keys(watcherExcludeObj).length === 0) delete settings[VSCODE_WATCHER_EXCLUDE_KEY];
  if (!dryRun) await writeJsonObject(file, settings);
  return { kind: "modify", path: relPath, detail: "removed Golem watcher excludes" };
}

/**
 * Install the bundled VS Code extension by copying it into VS Code's global
 * extensions dir (dependency-free, the same mechanism as `deploy:local`). Returns
 * null when VS Code isn't detected (the probe returns no dir) so init stays a
 * no-op on machines without it. Idempotent: an already-installed same-version
 * copy is a skip.
 */
export async function installVscodeExtension(
  options: InitOptions,
  dryRun: boolean,
): Promise<InitAction | null> {
  const probe = options.probe ?? defaultProbe();
  const extensionsDir = (await probe.vscodeExtensionsDir?.()) ?? null;
  if (extensionsDir === null) return null;

  const sourceDir = options.vscodeSourceDir ?? defaultVscodeSourceDir();
  const manifest = await readJsonObject(path.join(sourceDir, "package.json")).catch(() => null);
  if (manifest === null) return null; // source not shipped/available — skip quietly
  const id = `${String(manifest.publisher)}.${String(manifest.name)}-${String(manifest.version)}`;
  const target = path.join(extensionsDir, id);

  // R9.16: "the directory exists" is NOT "the right bytes are in it". The dir is
  // named for the extension version, so shipping a fix without a version bump
  // made every later init a silent no-op — and a stale `render.js` then named a
  // model the coder was not using. Compare content, refresh when it differs.
  const inspected = await inspectVscodeExtension({ sourceDir, extensionsDir });
  if (inspected.state === "current") {
    return { kind: "skip", path: `~/.vscode/extensions/${id}`, detail: "already up to date" };
  }
  if (!dryRun) {
    await mkdir(target, { recursive: true });
    for (const name of VSCODE_EXTENSION_FILES) {
      const src = path.join(sourceDir, name);
      // `force: true` so a refresh overwrites rather than failing on an existing
      // file. Safe here and nowhere else: this is Golem's own build artifact in
      // VS Code's directory, not a document the user may have edited (R9.5).
      if (await pathExists(src)) {
        await cp(src, path.join(target, name), { recursive: true, force: true });
      }
    }
  }
  return inspected.state === "stale"
    ? {
        kind: "modify",
        path: `~/.vscode/extensions/${id}`,
        detail: `refreshed ${inspected.staleFiles.join(", ")} — reload the VS Code window`,
      }
    : {
        kind: "create",
        path: `~/.vscode/extensions/${id}`,
        detail: "VS Code panel + status bar (reload the window to activate)",
      };
}

/** Remove any installed Golem VS Code extension(s) — matches `golem-run.golem-vscode-*`. */
export async function removeVscodeExtensions(
  options: UninitOptions,
  dryRun: boolean,
): Promise<InitAction[]> {
  const probe = options.probe ?? defaultProbe();
  const extensionsDir = (await probe.vscodeExtensionsDir?.()) ?? null;
  if (extensionsDir === null) return [];
  let entries: string[];
  try {
    entries = await readdir(extensionsDir);
  } catch {
    return [];
  }
  const mine = entries.filter((e) => e.startsWith("golem-run.golem-vscode-"));
  const out: InitAction[] = [];
  for (const id of mine) {
    out.push({ kind: "remove", path: `~/.vscode/extensions/${id}`, detail: "VS Code extension" });
    if (!dryRun) await rm(path.join(extensionsDir, id), { recursive: true, force: true });
  }
  return out;
}
