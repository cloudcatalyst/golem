/**
 * Copy non-TS runtime assets into dist/ after `tsc` (which only emits .js/.d.ts).
 *
 * DISCOVERED, never hand-listed. The list this replaced named exactly one of the
 * two Python workers, so `headroom-memory-worker.py` was absent from every built
 * install and the MEMORY sidecar could not start — silently, because it fails
 * open (R10.5). A list a human has to remember to update *is* the bug; the fix
 * is to derive it from what is actually in `src/`.
 *
 * The rule: every file under `src/` that `tsc` does not emit is a runtime asset
 * and is copied to the same relative path under `dist/`. Shipping one file too
 * many costs a few KB in the tarball; shipping one too few is a feature that
 * quietly does nothing.
 *
 * Cross-platform (node:fs, node:path), so it works in the 3-OS CI matrix.
 * Importable without side effects — the copy runs only when this file is the
 * entry point — so `tests/unit/runtime-assets-drift.test.ts` can assert against
 * the same discovery the build uses, rather than a second copy of the list.
 */
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Repo root, resolved from this script's own location (never the cwd). */
export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Extensions TypeScript compiles and emits into dist/ by itself. Everything else
 * under src/ is an asset the compiler drops on the floor.
 */
const COMPILED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

/**
 * Local tooling detritus that is not source and must never reach a published
 * tarball. Running either worker by hand leaves a `__pycache__` next to it, and
 * a copy-everything rule shipped those .pyc files on the first build.
 */
const IGNORED_DIRECTORIES = new Set(["__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache"]);
const IGNORED_EXTENSIONS = new Set([".pyc", ".pyo"]);
const IGNORED_NAMES = new Set([".DS_Store", "Thumbs.db"]);

function extensionOf(name) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot);
}

/** Split a posix-relative asset path into segments for `join`. */
function segments(relPosix) {
  return relPosix.split(posix.sep);
}

/**
 * Every runtime asset under `src/`, as posix-relative paths (e.g.
 * `compression/headroom-worker.py`). Sorted, so build output and test failures
 * are stable.
 */
export async function discoverRuntimeAssets(root = repoRoot) {
  const srcDir = join(root, "src");
  const found = [];
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (IGNORED_NAMES.has(entry.name)) continue;
      const ext = extensionOf(entry.name);
      if (COMPILED_EXTENSIONS.has(ext) || IGNORED_EXTENSIONS.has(ext)) continue;
      found.push(relative(srcDir, full).split(sep).join(posix.sep));
    }
  };
  await walk(srcDir);
  return found.sort();
}

/** Copy every discovered asset from `src/` to `dist/`. Returns what it copied. */
export async function copyRuntimeAssets(root = repoRoot, write = () => {}) {
  const assets = await discoverRuntimeAssets(root);
  for (const rel of assets) {
    const dest = join(root, "dist", ...segments(rel));
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(join(root, "src", ...segments(rel)), dest);
    write(`copied src/${rel} -> dist/${rel}\n`);
  }
  return assets;
}

// Entry-point guard: importing this module must not copy anything.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const copied = await copyRuntimeAssets(repoRoot, (m) => process.stdout.write(m));
  if (copied.length === 0) {
    // Zero assets means the walk found nothing where two Python workers live —
    // a broken build that would otherwise succeed and ship a crippled dist/.
    process.stderr.write(
      "copy-assets: no runtime assets found under src/ — refusing to call this a build\n",
    );
    process.exitCode = 1;
  }
}
