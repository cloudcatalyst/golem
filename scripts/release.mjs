/**
 * Bump the Golem version in lockstep across every surface (Decision 41a).
 *
 * package.json is canonical, but the VS Code extension carries its own
 * `version` and the compiled-in `VERSION` (src/version.ts) is generated from
 * package.json. This bumps the two package.json files together, regenerates
 * src/version.ts, and prints the release steps — it does NOT tag, commit,
 * publish, or push. Those are outward, credentialed acts left to the user
 * (Decision 41 / RELEASING.md).
 *
 *   node scripts/release.mjs <patch|minor|major|X.Y.Z>
 *
 * Cross-platform: pure node fs + a child node call to sync-version.
 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const arg = process.argv[2];
if (arg === undefined) {
  process.stderr.write("usage: node scripts/release.mjs <patch|minor|major|X.Y.Z>\n");
  process.exit(1);
}

const PKGS = ["package.json", join("vscode-extension", "package.json")];

/** Parse "X.Y.Z" (ignoring any prerelease/build suffix) into [major, minor, patch]. */
function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) throw new Error(`not a semver version: "${v}"`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Resolve the target version from the bump keyword or an explicit semver. */
function nextVersion(current, bump) {
  if (/^\d+\.\d+\.\d+/.test(bump)) return bump;
  const [major, minor, patch] = parseSemver(current);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unknown bump "${bump}" — use patch | minor | major | X.Y.Z`);
}

// The root package.json version is the source of truth for "current".
const rootPkgPath = join(root, "package.json");
const current = JSON.parse(await readFile(rootPkgPath, "utf8")).version;
const target = nextVersion(current, arg);
parseSemver(target); // validate explicit input too

for (const rel of PKGS) {
  const path = join(root, rel);
  const raw = await readFile(path, "utf8");
  const pkg = JSON.parse(raw);
  pkg.version = target;
  // 2-space indent + trailing newline matches the repo's existing package.json files.
  await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  process.stdout.write(`release: ${rel} ${current} -> ${target}\n`);
}

// Regenerate the compiled-in constant from the just-bumped package.json.
execFileSync(process.execPath, [join(root, "scripts", "sync-version.mjs")], { stdio: "inherit" });

process.stdout.write(
  [
    "",
    `Version bumped to ${target}. Not committed/tagged/published (deliberate — see RELEASING.md).`,
    "Next:",
    "  1. npm run check && npm run build",
    `  2. git commit -am "chore(release): v${target}"`,
    `  3. git tag v${target}`,
    "  4. npm publish            # golem-run (requires npm auth)",
    "  5. (optional) build + attach standalone binaries: npm run build:binary",
    "  6. (optional) publish the VS Code extension: cd vscode-extension && npx @vscode/vsce publish",
    "",
  ].join("\n"),
);
