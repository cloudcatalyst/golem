/**
 * Cross-compile standalone `golem` binaries with Bun (Decision 41d).
 *
 * Produces one self-contained executable per OS/arch (Bun runtime baked in — no
 * Node prerequisite on the target), for the no-Node install tier (install/*).
 * Requires Bun on the build host; intended for the CI release workflow, not the
 * default `npm run build`. NOT part of the pure-Node core install.
 *
 *   npm run build:binary            # all targets
 *   node scripts/build-binary.mjs bun-linux-x64 bun-darwin-arm64   # subset
 *
 * Version is compiled in via the generated src/version.ts (regenerated here
 * first), so the binary reports the same VERSION as the npm package.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Full target matrix (Bun `--target` names, verified 2026-07-22, notes §70).
const ALL_TARGETS = [
  "bun-windows-x64",
  "bun-windows-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
  "bun-linux-x64",
  "bun-linux-arm64",
];

const requested = process.argv.slice(2);
const targets = requested.length > 0 ? requested : ALL_TARGETS;
const unknown = targets.filter((t) => !ALL_TARGETS.includes(t));
if (unknown.length > 0) {
  process.stderr.write(`build-binary: unknown target(s): ${unknown.join(", ")}\n`);
  process.stderr.write(`  valid: ${ALL_TARGETS.join(", ")}\n`);
  process.exit(1);
}

// Fail early + clearly if Bun is absent (dev boxes without it, e.g. this repo's).
if (spawnSync("bun", ["--version"], { shell: true }).status !== 0) {
  process.stderr.write(
    "build-binary: Bun is not installed. Install it from https://bun.sh, or run this in the CI release workflow.\n",
  );
  process.exit(1);
}

// Keep the compiled-in VERSION in sync with package.json before bundling.
execFileSync(process.execPath, [join(root, "scripts", "sync-version.mjs")], { stdio: "inherit" });

const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
const outDir = join(root, "dist-bin");
await mkdir(outDir, { recursive: true });

const entry = join("src", "cli", "main.ts");
let failed = 0;
for (const target of targets) {
  const isWindows = target.includes("windows");
  // golem-<os>-<arch>[-<version>][.exe] — keep it parseable by the installer.
  const base = `golem-${target.replace(/^bun-/, "")}`;
  const outfile = join(outDir, isWindows ? `${base}.exe` : base);
  const args = [
    "build",
    "--compile",
    "--minify",
    "--sourcemap",
    `--target=${target}`,
    entry,
    "--outfile",
    outfile,
  ];
  process.stdout.write(`build-binary: ${target} -> ${outfile} (v${version})\n`);
  const res = spawnSync("bun", args, { cwd: root, stdio: "inherit", shell: true });
  if (res.status !== 0) {
    failed += 1;
    process.stderr.write(`build-binary: FAILED ${target} (exit ${res.status})\n`);
  }
}

if (failed > 0) {
  process.stderr.write(`build-binary: ${failed}/${targets.length} target(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`build-binary: built ${targets.length} target(s) into dist-bin/\n`);
