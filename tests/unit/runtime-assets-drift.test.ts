/**
 * R10.5 — a build that silently omits a runtime asset.
 *
 * `scripts/copy-assets.mjs` used to carry a hand-written list naming ONE of the
 * two Python workers. `headroom-memory-worker.py` was therefore missing from
 * every built install, `defaultMemoryWorkerPath()` resolved to a file that was
 * not there, and the MEMORY sidecar failed open — so the feature was off by
 * accident for months without a single failing test or error message. It worked
 * under `tsx`, where the asset sits next to its source, which is why nobody saw
 * it.
 *
 * These assert the invariant that would have caught it: anything `src/` loads by
 * PATH at runtime is something the build copies into `dist/`. They read the
 * build script's own discovery rather than restating the filenames, so a new
 * asset is covered the day it is added — a guard that needs updating by hand is
 * the same class of bug it is guarding against.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../helpers/tmp.js";

// R13.5 — a LOCAL ceiling, with the measurement that justifies it, following the
// same reasoning (and the same targeted approach) as `cli-init.test.ts`.
//
// Every test in this file walks the WHOLE of `src/` and reads each `.ts` file,
// and two of them do it twice. That is real work whose cost grows with the
// codebase: measured 2026-08-29, ~500ms alone and **6.1s** inside a full
// parallel run, which put it close enough to the 5s default to fail about half
// the time — as a timeout, never as a wrong answer. The cause is environmental
// (≈15 vitest workers doing filesystem work on Windows, where every read is a
// virus-scanner event), not a slow code path.
//
// Raised here only, so the default still guards everything else. If this file
// ever fails on CONTENT rather than time, that is a real drift finding and the
// message will say so.
vi.setConfig({ testTimeout: 60_000 });

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcDir = path.join(repoRoot, "src");

/**
 * Load the build script itself. Dynamic + untyped on purpose: this must be THE
 * module `npm run build` runs, not a typed re-declaration of it that could
 * drift.
 */
async function loadCopyAssets(): Promise<{
  discoverRuntimeAssets: (root?: string) => Promise<string[]>;
  copyRuntimeAssets: (root?: string, write?: (m: string) => void) => Promise<string[]>;
}> {
  const url = pathToFileURL(path.join(repoRoot, "scripts", "copy-assets.mjs")).href;
  return (await import(url)) as Awaited<ReturnType<typeof loadCopyAssets>>;
}

/** Every file under `dir` matching `predicate`, as absolute paths. */
async function walk(dir: string, predicate: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, predicate)));
    else if (entry.isFile() && predicate(entry.name)) out.push(full);
  }
  return out;
}

/** Module specifiers the compiler resolves for us — not assets. */
const MODULE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

/**
 * Sibling-relative paths resolved at runtime from `import.meta.url` — the
 * `fileURLToPath(new URL("./worker.py", import.meta.url))` shape both sidecars
 * use. Returns posix paths relative to `src/`; references that escape `src/` are
 * returned separately, since the build script's remit stops at `src/`.
 */
async function scanPathResolvedReferences(): Promise<{ inside: string[]; outside: string[] }> {
  const pattern = /new URL\(\s*(["'`])([^"'`]+)\1\s*,\s*import\.meta\.url\s*\)/g;
  const inside = new Set<string>();
  const outside = new Set<string>();
  for (const file of await walk(srcDir, (n) => n.endsWith(".ts"))) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      const spec = match[2];
      if (spec === undefined || !spec.startsWith(".")) continue;
      if (MODULE_EXTENSIONS.has(path.extname(spec))) continue;
      const resolved = path.resolve(path.dirname(file), spec);
      const rel = path.relative(srcDir, resolved);
      if (rel.startsWith("..") || path.isAbsolute(rel)) outside.add(spec);
      else inside.add(rel.split(path.sep).join(path.posix.sep));
    }
  }
  return { inside: [...inside].sort(), outside: [...outside].sort() };
}

const newTempDir = useTempDirs("golem-assets-");

describe("runtime assets are shipped to dist/", () => {
  it("discovers both Headroom workers — the sidecar and the one that was missing", async () => {
    const { discoverRuntimeAssets } = await loadCopyAssets();
    const assets = await discoverRuntimeAssets();
    expect(assets).toContain("compression/headroom-worker.py");
    expect(assets).toContain("compression/headroom-memory-worker.py");
  });

  it("ships every file src/ resolves by path at runtime", async () => {
    const { discoverRuntimeAssets } = await loadCopyAssets();
    const [assets, refs] = await Promise.all([
      discoverRuntimeAssets(),
      scanPathResolvedReferences(),
    ]);
    // Anti-vacuous: a scan that silently matched nothing would pass everything.
    expect(refs.inside).toContain("compression/headroom-memory-worker.py");
    for (const ref of refs.inside) expect(assets).toContain(ref);
  });

  it("copies the whole discovered set, preserving relative layout", async () => {
    const { copyRuntimeAssets, discoverRuntimeAssets } = await loadCopyAssets();
    const root = await newTempDir();
    await mkdir(path.join(root, "src", "compression", "nested"), { recursive: true });
    await mkdir(path.join(root, "src", "compression", "__pycache__"), { recursive: true });
    await writeFile(path.join(root, "src", "compression", "worker.py"), "print(1)\n", "utf8");
    await writeFile(path.join(root, "src", "compression", "adapter.ts"), "export {};\n", "utf8");
    await writeFile(path.join(root, "src", "compression", "nested", "model.bin"), "x", "utf8");
    // Running a worker by hand leaves these behind; copy-everything shipped them.
    await writeFile(
      path.join(root, "src", "compression", "__pycache__", "worker.cpython-313.pyc"),
      "junk",
      "utf8",
    );

    expect(await discoverRuntimeAssets(root)).toEqual([
      "compression/nested/model.bin",
      "compression/worker.py",
    ]);
    const copied = await copyRuntimeAssets(root);
    expect(copied).toHaveLength(2);
    expect(existsSync(path.join(root, "dist", "compression", "worker.py"))).toBe(true);
    expect(existsSync(path.join(root, "dist", "compression", "nested", "model.bin"))).toBe(true);
    // The compiler's own output is not this script's business.
    expect(existsSync(path.join(root, "dist", "compression", "adapter.ts"))).toBe(false);
    expect(existsSync(path.join(root, "dist", "compression", "__pycache__"))).toBe(false);
  });

  it("a built dist/ actually contains them", async () => {
    // Only meaningful after `npm run build`; a source checkout that has never
    // built has nothing to be wrong about.
    if (!existsSync(path.join(repoRoot, "dist", "compression", "headroom-adapter.js"))) return;
    const { discoverRuntimeAssets } = await loadCopyAssets();
    const missing = (await discoverRuntimeAssets()).filter(
      (rel) => !existsSync(path.join(repoRoot, "dist", ...rel.split(path.posix.sep))),
    );
    expect(missing).toEqual([]);
  });

  it("keeps the one path-resolved asset that lives outside src/ in package.json files", async () => {
    // `src/cli/vscode-extension.ts` resolves `../../vscode-extension` — outside
    // src/, so `copy-assets` cannot cover it and the npm `files` list must.
    const refs = await scanPathResolvedReferences();
    expect(refs.outside).toEqual(["../../vscode-extension"]);
    const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      files?: string[];
    };
    expect(pkg.files?.some((f) => f.startsWith("vscode-extension/"))).toBe(true);
  });
});
