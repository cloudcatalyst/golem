/**
 * R8.10 — the dependency gate must actually fail.
 *
 * `save-exact=true` only governs future `npm install` calls; it cannot pin what is
 * already in package.json and it cannot stop a hand-edit reintroducing a range.
 * `scripts/verify-deps.mjs` is the enforcement, wired into `npm run check` — so a
 * gate that silently passes is worse than none, and each failure mode is asserted
 * here against a synthetic project tree.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmTemp } from "../helpers/tmp.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "verify-deps.mjs");

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run the verifier with `cwd`-relative paths resolved against `dir`. */
async function run(dir: string): Promise<RunResult> {
  // The script resolves paths relative to its own location, so a fixture run
  // needs a copy of it inside the fixture tree.
  const script = path.join(dir, "scripts", "verify-deps.mjs");
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script], { cwd: dir });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const GOOD_NPMRC = "save-exact=true\nmin-release-age=2\n";

async function fixture(
  dir: string,
  over: {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    npmrc?: string | null;
    lockVersions?: Record<string, string> | null;
  } = {},
): Promise<void> {
  const dependencies = over.dependencies ?? { zod: "3.25.76" };
  const optionalDependencies = over.optionalDependencies ?? {};
  const { mkdir, copyFile } = await import("node:fs/promises");
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await copyFile(SCRIPT, path.join(dir, "scripts", "verify-deps.mjs"));
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fixture", dependencies, optionalDependencies }, null, 2),
    "utf8",
  );
  if (over.npmrc !== null) {
    await writeFile(path.join(dir, ".npmrc"), over.npmrc ?? GOOD_NPMRC, "utf8");
  }
  if (over.lockVersions !== null) {
    const all = { ...dependencies, ...optionalDependencies };
    const versions = over.lockVersions ?? all;
    const packages: Record<string, { version: string }> = {};
    for (const name of Object.keys(all)) {
      const v = versions[name];
      if (v !== undefined) packages[`node_modules/${name}`] = { version: v };
    }
    await writeFile(
      path.join(dir, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages }, null, 2),
      "utf8",
    );
  }
}

describe("verify-deps", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-verify-deps-"));
  });

  afterEach(async () => {
    await rm(dir, rmTemp);
  });

  it("passes on this repository as it stands", async () => {
    const { stdout } = await execFileAsync(process.execPath, [SCRIPT], { cwd: REPO_ROOT });
    expect(stdout).toContain("verify-deps: ok");
    expect(stdout).toContain("all pinned exactly");
  });

  it("passes a well-formed fixture", async () => {
    await fixture(dir);
    const result = await run(dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  it("fails a caret range on a direct dependency", async () => {
    await fixture(dir, { dependencies: { zod: "^3.25.0" }, lockVersions: { zod: "3.25.76" } });
    const result = await run(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("must be pinned exactly");
  });

  it("fails a tilde range, a tag, and a URL dependency", async () => {
    for (const range of ["~3.25.0", "latest", "github:colinhacks/zod"]) {
      const sub = await mkdtemp(path.join(tmpdir(), "golem-vd-range-"));
      try {
        await fixture(sub, { dependencies: { zod: range }, lockVersions: { zod: "3.25.76" } });
        const result = await run(sub);
        expect(result.code, `range ${range} should fail`).toBe(1);
      } finally {
        await rm(sub, rmTemp);
      }
    }
  });

  it("checks optional dependencies too", async () => {
    await fixture(dir, {
      optionalDependencies: { unpdf: "^1.6.2" },
      lockVersions: { zod: "3.25.76", unpdf: "1.6.2" },
    });
    const result = await run(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unpdf");
  });

  it("fails when a pin disagrees with the lockfile", async () => {
    await fixture(dir, { dependencies: { zod: "3.25.76" }, lockVersions: { zod: "3.24.0" } });
    const result = await run(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("the lockfile resolved 3.24.0");
  });

  it("fails when a pinned dependency is absent from the lockfile", async () => {
    await fixture(dir, { dependencies: { zod: "3.25.76" }, lockVersions: {} });
    const result = await run(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("absent from package-lock.json");
  });

  it("fails when .npmrc is missing", async () => {
    await fixture(dir, { npmrc: null });
    const result = await run(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(".npmrc is missing");
  });

  it("fails when save-exact is dropped from .npmrc", async () => {
    await fixture(dir, { npmrc: "min-release-age=2\n" });
    const result = await run(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("save-exact");
  });

  it("fails when min-release-age is dropped from .npmrc", async () => {
    await fixture(dir, { npmrc: "save-exact=true\n" });
    const result = await run(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("min-release-age");
  });

  it("fails when the runtime dependency count creeps past the ceiling", async () => {
    await fixture(dir, {
      dependencies: {
        a: "1.0.0",
        b: "1.0.0",
        c: "1.0.0",
        d: "1.0.0",
        e: "1.0.0",
        f: "1.0.0",
      },
    });
    const result = await run(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("exceeds the 5 allowed");
  });

  it("fails when the lockfile is missing entirely", async () => {
    await fixture(dir, { lockVersions: null });
    const result = await run(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("dependency ground truth");
  });
});
