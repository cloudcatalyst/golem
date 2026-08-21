/**
 * Detection primitives for the managed-package registry (spec Decision 53).
 *
 * Deliberately **spawn-free**: detection walks `PATH`, asks Node's resolver, and
 * reads one small JSON registry, so `golem pkg list` costs a handful of `stat`
 * calls rather than a process per tool. That matters because this is the surface
 * people run to answer "is it even installed?", and because Decision 51 made CLI
 * startup a standing constraint.
 *
 * Cross-platform per CLAUDE.md: `node:path`/`node:os` only, `PATHEXT` honoured
 * on Windows (an npm-installed CLI is a `.cmd` shim there, not an `.exe`, so
 * `execFile("caveman")` would fail while the tool is plainly installed), and no
 * shell strings anywhere.
 */

import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

/** Default Windows executable extensions when `PATHEXT` is unset. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Candidate filenames for `name` on this platform: the bare name plus each
 * `PATHEXT` extension on Windows. If the caller already supplied an extension
 * that `PATHEXT` knows about, the bare name is tried first and the extensions
 * are still appended (harmless, and it keeps the logic branch-free).
 */
function candidateNames(name: string, env: Readonly<Record<string, string | undefined>>): string[] {
  if (process.platform !== "win32") return [name];
  const exts = (env.PATHEXT ?? DEFAULT_PATHEXT)
    .split(";")
    .map((ext) => ext.trim())
    .filter((ext) => ext.length > 0);
  return [name, ...exts.map((ext) => `${name}${ext}`)];
}

/**
 * Absolute path of `name` if it is an executable on `PATH`, else `null`.
 *
 * Windows-aware (`PATHEXT`), and it never spawns anything — so it is safe to
 * call for every registry row on a hot-ish path.
 */
export function commandOnPath(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  // An explicit path (`./tool`, `/usr/local/bin/tool`, `C:\bin\tool.exe`) is
  // not a PATH lookup at all — check it directly.
  if (name.includes("/") || name.includes("\\")) {
    for (const candidate of candidateNames(name, env)) {
      if (isFile(candidate)) return path.resolve(candidate);
    }
    return null;
  }

  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter((d) => d.length > 0);
  for (const dir of dirs) {
    for (const candidate of candidateNames(name, env)) {
      const full = path.join(dir, candidate);
      if (isFile(full)) return full;
    }
  }
  return null;
}

/**
 * Resolved path of an optional npm module, or `null` when it is not installed.
 *
 * Uses `require.resolve` rather than `import()` on purpose: resolution alone
 * answers "is it installed" without *executing* the package, which keeps this
 * free of side effects and of the package's own load cost.
 */
export function moduleOnDisk(specifier: string): string | null {
  try {
    return createRequire(import.meta.url).resolve(specifier);
  } catch {
    return null;
  }
}

/** `~/.claude/plugins`, honouring `HOME` / `HOMEDRIVE`+`HOMEPATH` first. */
function claudePluginsRoot(env: Readonly<Record<string, string | undefined>>): string {
  const home =
    env.HOME ?? (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : homedir());
  return path.join(home, ".claude", "plugins");
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Plugin ids recorded as installed, or `null` when the registry cannot be read
 * (absent, unreadable, or not the shape this reader knows). `null` means "no
 * answer", which is different from `[]` — "answered: nothing is installed".
 */
function installedPluginIds(registryPath: string): string[] | null {
  let raw: string;
  try {
    raw = readFileSync(registryPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { plugins?: Record<string, unknown> };
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.plugins !== "object" || parsed.plugins === null) return null;
    return Object.keys(parsed.plugins);
  } catch {
    return null;
  }
}

/**
 * Does a recorded id name this plugin? Ids are `<name>` or `<name>@<marketplace>`;
 * a caller-supplied marketplace must match when the id carries one.
 */
function pluginIdMatches(id: string, name: string, marketplace?: string): boolean {
  const at = id.lastIndexOf("@");
  const idName = at > 0 ? id.slice(0, at) : id;
  const idMarket = at > 0 ? id.slice(at + 1) : undefined;
  if (idName !== name) return false;
  return marketplace === undefined || idMarket === undefined || idMarket === marketplace;
}

/**
 * Is a Claude Code plugin installed? Returns a path that evidences the claim, or
 * `null`.
 *
 * **`~/.claude/plugins/installed_plugins.json` is the authority, not the content
 * cache.** `claude plugin uninstall` empties that file but leaves
 * `cache/<marketplace>/<name>/<hash>/` behind, so the old cache-directory check
 * reported a plugin as `[found]` when `claude plugin list` said nothing was
 * installed (verification-notes §133). That false positive matters more now that
 * `golem pkg remove` exists: a surface whose whole point is "presence and
 * configuration, honestly" must not keep claiming a package it just removed.
 *
 * The cache directory stays as the fallback for a Claude Code old enough to have
 * no registry file — there, a leftover cache is the only signal available.
 * Still spawn-free: one small JSON read plus a `stat`.
 */
export function pluginOnDisk(
  name: string,
  marketplace?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const root = claudePluginsRoot(env);
  const cacheDir = path.join(root, "cache", marketplace ?? name, name);
  const registry = path.join(root, "installed_plugins.json");

  const installed = installedPluginIds(registry);
  if (installed !== null) {
    if (!installed.some((id) => pluginIdMatches(id, name, marketplace))) return null;
    // Point at the payload where there is one; otherwise at the record itself.
    return isDirectory(cacheDir) ? cacheDir : registry;
  }
  return isDirectory(cacheDir) ? cacheDir : null;
}
