/**
 * Detection primitives for the managed-tool registry (spec Decision 53).
 *
 * Deliberately **spawn-free**: detection walks `PATH` and asks Node's resolver,
 * so `golem ext list` costs a few `stat` calls rather than a process per tool.
 * That matters because this is the surface people run to answer "is it even
 * installed?", and because Decision 51 made CLI startup a standing constraint.
 *
 * Cross-platform per CLAUDE.md: `node:path`/`node:os` only, `PATHEXT` honoured
 * on Windows (an npm-installed CLI is a `.cmd` shim there, not an `.exe`, so
 * `execFile("caveman")` would fail while the tool is plainly installed), and no
 * shell strings anywhere.
 */

import { statSync } from "node:fs";
import { createRequire } from "node:module";
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
