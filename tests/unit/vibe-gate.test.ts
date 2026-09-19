/**
 * The gate: only a Golem-initialised project may read the personal vibe guide.
 *
 * This is the invariant the whole feature rests on. The guide is PERSONAL and
 * derived from the user's real source files, and the skill that reaches it is
 * just a markdown file that anyone could copy into any repository — so "the
 * skill is only installed in Golem projects" is a convention, not a control.
 *
 * The control is that nothing under `~/.golem/vibe/` is opened until
 * `findProjectDir` has found a project. That is asserted here the strong way:
 * a fully populated guide is placed on disk, and the test proves the filesystem
 * was never touched at those paths — not merely that the call returned nothing.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../helpers/tmp.js";

// Hoisted so the mock factory below can close over it: vi.mock is lifted above
// the imports, so a plain `const` here would not exist yet when it runs.
const fsCalls = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const record = <T extends (...args: never[]) => unknown>(fn: T): T =>
    ((...args: Parameters<T>) => {
      fsCalls.paths.push(String(args[0]));
      return fn(...args);
    }) as T;
  return {
    ...actual,
    readFile: record(actual.readFile),
    readdir: record(actual.readdir),
    stat: record(actual.stat),
    writeFile: record(actual.writeFile),
    mkdir: record(actual.mkdir),
  };
});

const { loadVibeContext, openVibeStore, vibePaths } = await import("../../src/vibe/index.js");

const newTempDir = useTempDirs("golem-vg");

/** A populated guide on disk, so "returned nothing" cannot be a false pass. */
async function writeGuide(userDir: string): Promise<void> {
  const p = vibePaths(userDir);
  await mkdir(path.join(p.snippets, "typescript"), { recursive: true });
  await mkdir(p.guidelines, { recursive: true });
  await writeFile(p.brief, "# Personal vibe\n\nTabs, double quotes.\n", "utf8");
  await writeFile(path.join(p.guidelines, "formatting.md"), "# Formatting\n", "utf8");
  await writeFile(path.join(p.snippets, "typescript", "example.md"), "# example\n", "utf8");
}

describe("the vibe gate", () => {
  let base: string;
  let projectDir: string;
  let strangerDir: string;
  let userDir: string;

  beforeEach(async () => {
    base = await newTempDir();
    projectDir = path.join(base, "project");
    strangerDir = path.join(base, "stranger");
    userDir = path.join(base, "home", ".golem");
    await mkdir(path.join(projectDir, ".golem"), { recursive: true });
    await writeFile(path.join(projectDir, ".golem", "settings.json"), "{}\n", "utf8");
    await mkdir(strangerDir, { recursive: true });
    await writeGuide(userDir);
    fsCalls.paths.length = 0;
  });

  const touchedGuide = (): string[] =>
    fsCalls.paths.filter((p) => p.includes(`${path.sep}vibe${path.sep}`) || p.endsWith("vibe"));

  it("performs ZERO filesystem access on the guide from a directory that is not a Golem project", async () => {
    const store = openVibeStore({ cwd: strangerDir, userDir, rootDir: base });
    const ctx = await loadVibeContext({ cwd: strangerDir, userDir, rootDir: base });

    expect(store).toBeNull();
    expect(ctx).toBeNull();
    // The real assertion: not "it returned null" but "it never looked".
    expect(touchedGuide()).toEqual([]);
  });

  it("reads the guide from a Golem project", async () => {
    const ctx = await loadVibeContext({ cwd: projectDir, userDir, rootDir: base });

    expect(ctx).not.toBeNull();
    expect(ctx?.brief).toContain("Tabs, double quotes.");
    expect(ctx?.guidelines).toEqual(["formatting"]);
    expect(ctx?.snippets).toEqual(["typescript/example"]);
    expect(touchedGuide().length).toBeGreaterThan(0);
  });

  it("passes from a subdirectory of a Golem project, because the marker is above it", async () => {
    const nested = path.join(projectDir, "src", "deep");
    await mkdir(nested, { recursive: true });

    expect(openVibeStore({ cwd: nested, userDir, rootDir: base })).not.toBeNull();
  });

  it("does NOT treat the home directory as a project, though ~/.golem/settings.json exists there", async () => {
    // `~/.golem/settings.json` is the USER scope (Decision 19), and it sits at
    // exactly the path the project marker is looked for. Without this, an
    // upward walk from anywhere under the home directory finds it — which on a
    // developer machine is most of the disk, and the gate stops meaning
    // anything. Found on a real machine while smoke-testing, 2026-09-13.
    const home = path.join(base, "home");
    await mkdir(path.join(home, ".golem"), { recursive: true });
    await writeFile(path.join(home, ".golem", "settings.json"), "{}\n", "utf8");
    const somewhere = path.join(home, "scratch", "unrelated");
    await mkdir(somewhere, { recursive: true });
    fsCalls.paths.length = 0;

    expect(openVibeStore({ cwd: somewhere, userDir, home })).toBeNull();
    expect(touchedGuide()).toEqual([]);
  });

  it("treats an uninitialised project as a stranger, even one with a .golem directory", async () => {
    // A `.golem/` folder with no settings.json is not an initialised project —
    // a stray cache directory must not become a key to the personal guide.
    const halfway = path.join(base, "halfway");
    await mkdir(path.join(halfway, ".golem", "state"), { recursive: true });
    fsCalls.paths.length = 0;

    expect(openVibeStore({ cwd: halfway, userDir, rootDir: base })).toBeNull();
    expect(touchedGuide()).toEqual([]);
  });
});
