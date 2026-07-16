/**
 * WS-W W1b — `golemWikiInit` scaffold: fresh create, idempotent rerun, dry-run,
 * and relative/absolute wiki_dir resolution.
 */

import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkWiki, golemWikiInit, resolveWikiDir } from "../../../src/cli/wiki.js";

const ZONE_DIRS = [
  "concepts",
  "entities",
  "sources",
  "syntheses",
  "decisions",
  "debriefs",
  "questions",
  "artifacts",
];

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

let projectDir: string;
beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-wiki-init-"));
});
afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe("resolveWikiDir", () => {
  it("project-roots a relative setting", () => {
    expect(resolveWikiDir(projectDir, "docs/wiki")).toBe(path.join(projectDir, "docs/wiki"));
  });

  it("uses an absolute setting as-is", () => {
    const abs = path.join(tmpdir(), "elsewhere", "wiki");
    expect(resolveWikiDir(projectDir, abs)).toBe(abs);
  });
});

describe("golemWikiInit", () => {
  it("scaffolds WIKI.md and every zone directory on a fresh project", async () => {
    const wikiDir = resolveWikiDir(projectDir, "docs/wiki");
    const report = await golemWikiInit({ projectDir, wikiDir, now: () => "2026-07-10" });

    expect(report.dryRun).toBe(false);
    expect(report.actions.every((a) => a.kind === "create")).toBe(true);
    expect(report.actions).toHaveLength(1 + ZONE_DIRS.length);

    const schema = await readFile(path.join(wikiDir, "WIKI.md"), "utf8");
    expect(schema).toContain("created: 2026-07-10");
    expect(schema).toContain("# Project wiki — schema (Zone 0)");

    for (const zone of ZONE_DIRS) {
      expect(await exists(path.join(wikiDir, zone, ".gitkeep"))).toBe(true);
    }
  });

  it("is idempotent: rerun on a fully-scaffolded wiki reports only skips", async () => {
    const wikiDir = resolveWikiDir(projectDir, "docs/wiki");
    await golemWikiInit({ projectDir, wikiDir, now: () => "2026-07-10" });

    const again = await golemWikiInit({ projectDir, wikiDir, now: () => "2026-07-11" });
    expect(again.actions.every((a) => a.kind === "skip")).toBe(true);

    // Existing WIKI.md content is untouched (not overwritten with the new date).
    const schema = await readFile(path.join(wikiDir, "WIKI.md"), "utf8");
    expect(schema).toContain("created: 2026-07-10");
  });

  it("fills in only what's missing on a partial scaffold", async () => {
    const wikiDir = resolveWikiDir(projectDir, "docs/wiki");
    await mkdir(path.join(wikiDir, "concepts"), { recursive: true });
    await writeFile(path.join(wikiDir, "concepts", "existing.md"), "keep me", "utf8");

    const report = await golemWikiInit({ projectDir, wikiDir, now: () => "2026-07-10" });
    const byPath = new Map(report.actions.map((a) => [a.path, a.kind]));
    expect(byPath.get("docs/wiki/concepts")).toBe("skip");
    expect(byPath.get("docs/wiki/WIKI.md")).toBe("create");
    expect(byPath.get("docs/wiki/sources")).toBe("create");

    // Pre-existing content in the partially-scaffolded zone survives.
    expect(await readFile(path.join(wikiDir, "concepts", "existing.md"), "utf8")).toBe("keep me");
  });

  it("dry-run reports actions without writing anything", async () => {
    const wikiDir = resolveWikiDir(projectDir, "docs/wiki");
    const report = await golemWikiInit({ projectDir, wikiDir, dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.actions.every((a) => a.kind === "create")).toBe(true);
    expect(await exists(wikiDir)).toBe(false);
  });

  it("respects an absolute wiki_dir outside the project directory", async () => {
    const wikiDir = await mkdtemp(path.join(tmpdir(), "golem-wiki-external-"));
    try {
      const report = await golemWikiInit({ projectDir, wikiDir, now: () => "2026-07-10" });
      expect(await exists(path.join(wikiDir, "WIKI.md"))).toBe(true);
      // Reported paths fall back to the relative-walk-up form outside projectDir.
      expect(report.actions[0]?.path.endsWith("WIKI.md")).toBe(true);
    } finally {
      await rm(wikiDir, { recursive: true, force: true });
    }
  });
});

async function writePage(
  wikiDir: string,
  relPath: string,
  frontmatter: Record<string, string>,
  body: string,
): Promise<void> {
  const lines = [
    "---",
    ...Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`),
    "---",
    "",
    body,
  ];
  await mkdir(path.dirname(path.join(wikiDir, relPath)), { recursive: true });
  await writeFile(path.join(wikiDir, relPath), lines.join("\n"), "utf8");
}

const OK_FM = {
  title: "Prompt Caching",
  type: "concept",
  tags: "[cache]",
  sources: "[]",
  created: "2026-07-10",
  updated: "2026-07-10",
};

describe("checkWiki", () => {
  it("reports no issues for an empty (not-yet-scaffolded) wiki", async () => {
    const wikiDir = resolveWikiDir(projectDir, "docs/wiki");
    const report = await checkWiki(wikiDir);
    expect(report).toEqual({ pagesChecked: 0, issues: [] });
  });

  it("passes a well-formed wiki with a resolvable wikilink", async () => {
    const wikiDir = resolveWikiDir(projectDir, "docs/wiki");
    await writePage(wikiDir, "concepts/Prompt Caching.md", OK_FM, "See [[Other]].");
    await writePage(
      wikiDir,
      "concepts/Other.md",
      { ...OK_FM, title: "Other" },
      "See [[Prompt Caching]].",
    );
    const report = await checkWiki(wikiDir);
    expect(report).toEqual({ pagesChecked: 2, issues: [] });
  });

  it("exempts type: schema pages (e.g. WIKI.md) from the wikilink requirement", async () => {
    const wikiDir = resolveWikiDir(projectDir, "docs/wiki");
    await writePage(
      wikiDir,
      "WIKI.md",
      {
        title: "WIKI",
        type: "schema",
        tags: "[meta]",
        sources: "[]",
        created: "2026-07-10",
        updated: "2026-07-10",
      },
      "no links here",
    );
    const report = await checkWiki(wikiDir);
    expect(report.issues).toEqual([]);
  });

  it("flags a frontmatter parse error", async () => {
    const wikiDir = resolveWikiDir(projectDir, "docs/wiki");
    await mkdir(path.join(wikiDir, "concepts"), { recursive: true });
    await writeFile(path.join(wikiDir, "concepts", "Broken.md"), "not frontmatter at all", "utf8");
    const report = await checkWiki(wikiDir);
    expect(report.pagesChecked).toBe(0);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]?.message).toContain("frontmatter error");
  });

  it("flags an invalid type, malformed dates, and a missing wikilink", async () => {
    const wikiDir = resolveWikiDir(projectDir, "docs/wiki");
    await writePage(
      wikiDir,
      "concepts/Bad.md",
      { ...OK_FM, type: "nonsense", created: "07/10/2026" },
      "no links here",
    );
    const report = await checkWiki(wikiDir);
    const messages = report.issues.map((i) => i.message);
    expect(messages.some((m) => m.includes('invalid type "nonsense"'))).toBe(true);
    expect(messages.some((m) => m.includes("invalid created date"))).toBe(true);
    expect(messages.some((m) => m.includes("no wikilinks"))).toBe(true);
  });

  it("flags a broken wikilink to a nonexistent title", async () => {
    const wikiDir = resolveWikiDir(projectDir, "docs/wiki");
    await writePage(wikiDir, "concepts/Prompt Caching.md", OK_FM, "See [[Nonexistent]].");
    const report = await checkWiki(wikiDir);
    expect(report.issues).toEqual([
      { relPath: "concepts/Prompt Caching.md", message: "broken wikilink: [[Nonexistent]]" },
    ]);
  });

  it("R4.5: ignores wikilinks inside code (inline span or fenced block)", async () => {
    const wikiDir = resolveWikiDir(projectDir, "docs/wiki");
    await writePage(
      wikiDir,
      "concepts/Other.md",
      { ...OK_FM, title: "Other" },
      "See [[Prompt Caching]].",
    );
    // A real link ([[Other]]) plus example links inside code that must NOT be flagged.
    await writePage(
      wikiDir,
      "concepts/Prompt Caching.md",
      OK_FM,
      "Links look like `[[Page Title]]`. See [[Other]].\n\n```md\n[[Also Not Real]]\n```\n",
    );
    const report = await checkWiki(wikiDir);
    expect(report.issues).toEqual([]);
  });

  it("flags duplicate titles across two different pages", async () => {
    const wikiDir = resolveWikiDir(projectDir, "docs/wiki");
    await writePage(wikiDir, "concepts/A.md", OK_FM, "See [[Prompt Caching]].");
    await writePage(wikiDir, "concepts/B.md", OK_FM, "See [[Prompt Caching]].");
    const report = await checkWiki(wikiDir);
    const dupes = report.issues.filter((i) => i.message.startsWith("duplicate title"));
    expect(dupes).toHaveLength(2);
    expect(dupes.map((i) => i.relPath).sort()).toEqual(["concepts/A.md", "concepts/B.md"]);
  });
});
