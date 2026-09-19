/**
 * The guide on disk: the context budget, the redaction promise, and seeding.
 *
 * Three properties are load-bearing and each fails silently if it regresses:
 *
 * 1. **The brief is capped.** It is the only part loaded on every coding turn,
 *    so an uncapped brief is a permanent tax on every request in every project.
 * 2. **Everything is redacted before it lands.** The guide is built out of the
 *    user's real source files. A style guide is not a reason to copy a secret
 *    into the home directory.
 * 3. **A re-seed preserves the human's words.** The measured block is
 *    regenerated; the prose around it is theirs and must survive verbatim, or
 *    nobody will trust the file enough to write in it.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BRIEF_MAX_BYTES,
  capBrief,
  composeBrief,
  emptyObservation,
  observeSource,
  openVibeStore,
  seedFromPath,
  type VibeStore,
  vibeSlug,
} from "../../src/vibe/index.js";
import { useTempDirs } from "../helpers/tmp.js";

const newTempDir = useTempDirs("golem-vs");

describe("the vibe store", () => {
  let base: string;
  let projectDir: string;
  let userDir: string;
  let store: VibeStore;

  beforeEach(async () => {
    base = await newTempDir();
    projectDir = path.join(base, "project");
    userDir = path.join(base, "home", ".golem");
    await mkdir(path.join(projectDir, ".golem"), { recursive: true });
    await writeFile(path.join(projectDir, ".golem", "settings.json"), "{}\n", "utf8");
    const opened = openVibeStore({ cwd: projectDir, userDir, rootDir: base });
    if (opened === null) throw new Error("fixture is not a Golem project");
    store = opened;
  });

  describe("the context budget", () => {
    it("caps the brief that every coding turn pays for", async () => {
      const huge = `# Personal vibe\n\n${"A sentence about style. ".repeat(1000)}`;

      const bytes = await store.writeBrief(huge);

      expect(bytes).toBeLessThanOrEqual(BRIEF_MAX_BYTES);
      expect(Buffer.byteLength((await store.brief()) ?? "", "utf8")).toBeLessThanOrEqual(
        BRIEF_MAX_BYTES,
      );
    });

    it("cuts at a section boundary, so no rule is left half-stated", () => {
      const text = ["# Top", "", "## Kept", "short", "", "## Dropped", "x".repeat(9000)].join("\n");

      const capped = capBrief(text, 200);

      expect(capped).toContain("## Kept");
      expect(capped).not.toContain("## Dropped");
    });

    it("leaves a brief that already fits completely alone", () => {
      const text = "# Personal vibe\n\nTabs. Double quotes.\n";

      expect(capBrief(text)).toBe(text);
    });
  });

  describe("redaction before storage", () => {
    it("redacts a snippet captured from a file that contained a secret", async () => {
      const secret = `const key = "sk-ant-api03-${"a".repeat(80)}";`;

      const file = await store.writeSnippet("leaky", secret, {
        sourcePath: "/somewhere/leaky.ts",
        lang: "typescript",
        capturedAt: "2026-09-13T00:00:00.000Z",
      });

      // Assert on the STORED BYTES, not on the return value: the promise is
      // about what is on disk in the home directory.
      const stored = await readFile(file, "utf8");
      expect(stored).not.toContain(`sk-ant-api03-${"a".repeat(80)}`);
      expect(stored).toContain("/somewhere/leaky.ts");
    });

    it("redacts the brief too", async () => {
      await store.writeBrief(`# Personal vibe\n\nsk-ant-api03-${"b".repeat(80)}\n`);

      expect(await store.brief()).not.toContain(`sk-ant-api03-${"b".repeat(80)}`);
    });
  });

  describe("sources", () => {
    it("keys on path, so a re-seed updates in place rather than duplicating", async () => {
      await store.recordSource({ path: "/a", kind: "directory", addedAt: "1", files: 1 });
      await store.recordSource({ path: "/a", kind: "directory", addedAt: "2", files: 9 });

      const { sources } = await store.sources();
      expect(sources).toHaveLength(1);
      expect(sources[0]?.files).toBe(9);
    });

    it("reports no sources for a guide that has never been seeded", async () => {
      expect((await store.sources()).sources).toEqual([]);
    });
  });

  describe("slugs", () => {
    it("makes a filename-safe name", () => {
      expect(vibeSlug("Comment Voice!")).toBe("comment-voice");
    });

    it("refuses a name with nothing usable in it, rather than writing to a bare extension", () => {
      expect(() => vibeSlug("///")).toThrow(/alphanumeric/);
    });
  });

  describe("seeding", () => {
    it("measures real files and writes a guideline, snippets and a capped brief", async () => {
      const src = path.join(base, "exemplar");
      await mkdir(path.join(src, "node_modules"), { recursive: true });
      await writeFile(
        path.join(src, "a.ts"),
        ["// A comment that reads like prose.", 'const value = "x";', ""].join("\n"),
        "utf8",
      );
      await writeFile(path.join(src, "node_modules", "vendored.ts"), "const x = 1;\n", "utf8");

      const result = await seedFromPath(store, src, { now: new Date("2026-09-13T00:00:00Z") });

      // node_modules is skipped entirely — vendored code is not the user's style.
      expect(result.filesRead).toBe(1);
      expect(result.snippetsWritten).toBe(1);
      expect(result.briefBytes).toBeLessThanOrEqual(BRIEF_MAX_BYTES);
      expect(await store.listGuidelines()).toContain("formatting");
      expect(await store.readGuideline("formatting")).toContain("Formatting — measured");
      expect((await store.listSnippets()).map((s) => `${s.lang}/${s.id}`)).toEqual([
        "typescript/a",
      ]);
      expect((await store.sources()).sources[0]?.path).toBe(path.resolve(src));
    });

    it("preserves the human's prose across a re-seed and replaces only the measured block", () => {
      const o = observeSource('const a = "b";\n', emptyObservation());
      const first = composeBrief(null, o, "2026-09-13");
      const edited = `${first}\n## Voice\n\nI write comments as full sentences.\n`;

      const second = composeBrief(edited, observeSource("let c = 'd'\n", o), "2026-09-14");

      expect(second).toContain("I write comments as full sentences.");
      expect(second).toContain("Seeded from 2 file(s) on 2026-09-14");
      expect(second).not.toContain("2026-09-13");
    });
  });
});
