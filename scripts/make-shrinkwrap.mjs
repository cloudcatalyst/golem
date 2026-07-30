#!/usr/bin/env node
/**
 * R8.10 — generate `npm-shrinkwrap.json` for the published package.
 *
 * Why this exists: npm **ignores** a `package-lock.json` inside a published
 * tarball, so consumers of `golem-run` resolve transitive dependencies fresh at
 * install time — they get none of this repo's pinning. `npm-shrinkwrap.json` is
 * the one lockfile npm *does* honour when published, so a consumer installs the
 * exact tree that was tested here.
 *
 * It is generated rather than committed as a second source of truth:
 * `package-lock.json` stays the ground truth (CLAUDE.md: the lockfile is
 * committed), and this is a rename of it produced at release time. Keeping both
 * committed would guarantee they drift.
 *
 * Run before `npm publish` (see RELEASING.md). Safe to run repeatedly.
 */

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = path.join(ROOT, "package-lock.json");
const SHRINKWRAP = path.join(ROOT, "npm-shrinkwrap.json");

if (!existsSync(LOCK)) {
  process.stderr.write("make-shrinkwrap: package-lock.json not found — run `npm install` first.\n");
  process.exit(1);
}

// Sanity-check that the lockfile is the shape npm expects, so a corrupt file
// fails here rather than at publish time.
let lock;
try {
  lock = JSON.parse(readFileSync(LOCK, "utf8"));
} catch (err) {
  process.stderr.write(`make-shrinkwrap: package-lock.json is unparseable (${String(err)}).\n`);
  process.exit(1);
}
if (typeof lock.lockfileVersion !== "number" || lock.packages === undefined) {
  process.stderr.write(
    "make-shrinkwrap: package-lock.json has no lockfileVersion/packages — refusing to publish it.\n",
  );
  process.exit(1);
}

copyFileSync(LOCK, SHRINKWRAP);
const count = Object.keys(lock.packages).length;
process.stdout.write(
  `make-shrinkwrap: wrote npm-shrinkwrap.json (lockfileVersion ${lock.lockfileVersion}, ` +
    `${count} package entries). Consumers of the published tarball now install this exact tree.\n`,
);
