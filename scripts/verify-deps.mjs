#!/usr/bin/env node
/**
 * R8.10 — enforce the supply-chain posture that `.npmrc` only *requests*.
 *
 * `save-exact=true` governs future `npm install` calls; it cannot retroactively
 * pin what is already in package.json, and it does not stop a hand-edit from
 * reintroducing a range. This script is the gate, wired into `npm run verify`.
 *
 * Checks, in order of how likely each is to rot:
 *   1. every DIRECT dependency (incl. optional) is an exact version,
 *   2. `.npmrc` still asks for `save-exact` and a `min-release-age`,
 *   3. every direct dependency's pin matches what the lockfile resolved,
 *   4. the runtime dependency count has not crept up unnoticed.
 *
 * Internal workspace packages are exempt from (1) by design — Golem has none
 * today, but the vscode-extension is versioned in lockstep by `release.mjs`, so
 * the exemption is stated rather than discovered later.
 *
 * Exits 1 with a specific message per failure; prints one line on success.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Ceiling on runtime dependencies. Decision 51 brought this back to 6 by removing
 * ink; Decision 53 moved `unpdf` to optional, leaving 5. Raising this number is a
 * deliberate act, so it lives in one place and fails loudly.
 */
const MAX_RUNTIME_DEPS = 5;

/** An exact semver: no range operators, no tags, no URLs. */
const EXACT_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function read(file) {
  return readFileSync(path.join(ROOT, file), "utf8");
}

function fail(message) {
  process.stderr.write(`verify-deps: ${message}\n`);
  process.exitCode = 1;
}

const pkg = JSON.parse(read("package.json"));
const direct = { ...pkg.dependencies, ...pkg.optionalDependencies };
const failures = [];

// 1. Exact pins on every direct dependency.
for (const [name, range] of Object.entries(direct)) {
  if (!EXACT_RE.test(range)) {
    failures.push(
      `${name} is "${range}" — direct dependencies must be pinned exactly ` +
        `(no ^, ~, ranges, tags or URLs). See .npmrc / R8.10.`,
    );
  }
}

// 2. The .npmrc posture is still requested.
let npmrc = "";
try {
  npmrc = read(".npmrc");
} catch {
  failures.push(".npmrc is missing — it carries save-exact and min-release-age (R8.10).");
}
if (npmrc !== "" && !/^\s*save-exact\s*=\s*true\s*$/m.test(npmrc)) {
  failures.push(".npmrc no longer sets save-exact=true.");
}
if (npmrc !== "" && !/^\s*min-release-age\s*=\s*\d+\s*$/m.test(npmrc)) {
  failures.push(".npmrc no longer sets a min-release-age.");
}

// 3. Pins agree with what the lockfile actually resolved.
let lock;
try {
  lock = JSON.parse(read("package-lock.json"));
} catch {
  failures.push("package-lock.json is missing or unparseable — it is the dependency ground truth.");
}
if (lock !== undefined) {
  for (const [name, range] of Object.entries(direct)) {
    if (!EXACT_RE.test(range)) continue; // already reported above
    const entry = lock.packages?.[`node_modules/${name}`];
    if (entry === undefined) {
      failures.push(`${name} is pinned to ${range} but absent from package-lock.json.`);
    } else if (entry.version !== range) {
      failures.push(
        `${name} is pinned to ${range} but the lockfile resolved ${entry.version} — ` +
          `run \`npm install\` so the two agree.`,
      );
    }
  }
}

// 4. Runtime dependency count.
const runtimeCount = Object.keys(pkg.dependencies ?? {}).length;
if (runtimeCount > MAX_RUNTIME_DEPS) {
  failures.push(
    `${runtimeCount} runtime dependencies exceeds the ${MAX_RUNTIME_DEPS} allowed. ` +
      `Adding one is a deliberate act — raise MAX_RUNTIME_DEPS in this script and say why ` +
      `in the PR (CLAUDE.md: no heavyweight deps in the default install).`,
  );
}

if (failures.length > 0) {
  for (const message of failures) fail(message);
  process.stderr.write(`verify-deps: ${failures.length} problem(s).\n`);
} else {
  const optionalCount = Object.keys(pkg.optionalDependencies ?? {}).length;
  process.stdout.write(
    `verify-deps: ok — ${runtimeCount} runtime + ${optionalCount} optional dependency(ies), ` +
      `all pinned exactly, .npmrc posture intact.\n`,
  );
}
