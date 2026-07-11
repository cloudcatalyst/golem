/**
 * R3.4 (WS-W W4) — FederatedWikiReader merges a project wiki with a
 * user-scope wiki for read-only search/fetch (spec Decision 20e's local tier).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnknownWikiPageError } from "../../../src/interfaces/index.js";
import { FederatedWikiReader, FileWikiStore } from "../../../src/wiki/index.js";

let projectDir: string;
let userDir: string;
let project: FileWikiStore;
let user: FileWikiStore;
let federated: FederatedWikiReader;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-fed-project-"));
  userDir = await mkdtemp(path.join(tmpdir(), "golem-fed-user-"));
  project = new FileWikiStore({ wikiDir: projectDir, now: () => "2026-07-12" });
  user = new FileWikiStore({ wikiDir: userDir, now: () => "2026-07-12" });
  federated = new FederatedWikiReader(project, user);
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
  await rm(userDir, { recursive: true, force: true });
});

describe("FederatedWikiReader", () => {
  it("listPages merges both wikis, prefixing only the user wiki's relPath", async () => {
    await project.upsertPage({
      relPath: "concepts/Project Thing.md",
      frontmatter: { title: "Project Thing", type: "concept", tags: [], sources: [] },
      body: "project body",
    });
    await user.upsertPage({
      relPath: "concepts/Personal Habit.md",
      frontmatter: { title: "Personal Habit", type: "concept", tags: [], sources: [] },
      body: "user body",
    });

    const pages = await federated.listPages();
    const relPaths = pages.map((p) => p.relPath).sort();
    expect(relPaths).toEqual(["concepts/Project Thing.md", "user:concepts/Personal Habit.md"]);
  });

  it("readPage resolves a project path directly, unprefixed", async () => {
    await project.upsertPage({
      relPath: "concepts/Project Thing.md",
      frontmatter: { title: "Project Thing", type: "concept", tags: [], sources: [] },
      body: "project body",
    });
    const page = await federated.readPage("concepts/Project Thing.md");
    expect(page.relPath).toBe("concepts/Project Thing.md");
    expect(page.body).toContain("project body");
  });

  it("readPage resolves a user: prefixed path from the user wiki", async () => {
    await user.upsertPage({
      relPath: "concepts/Personal Habit.md",
      frontmatter: { title: "Personal Habit", type: "concept", tags: [], sources: [] },
      body: "user body",
    });
    const page = await federated.readPage("user:concepts/Personal Habit.md");
    expect(page.relPath).toBe("user:concepts/Personal Habit.md");
    expect(page.body).toContain("user body");
  });

  it("readPage falls back to the user wiki by title when the project has no match", async () => {
    await user.upsertPage({
      relPath: "concepts/Personal Habit.md",
      frontmatter: { title: "Personal Habit", type: "concept", tags: [], sources: [] },
      body: "user body",
    });
    const page = await federated.readPage("Personal Habit");
    expect(page.relPath).toBe("user:concepts/Personal Habit.md");
  });

  it("readPage lets the project win a title collision", async () => {
    await project.upsertPage({
      relPath: "concepts/Shared Title.md",
      frontmatter: { title: "Shared Title", type: "concept", tags: [], sources: [] },
      body: "project version",
    });
    await user.upsertPage({
      relPath: "concepts/Shared Title.md",
      frontmatter: { title: "Shared Title", type: "concept", tags: [], sources: [] },
      body: "user version",
    });
    const page = await federated.readPage("Shared Title");
    expect(page.body).toContain("project version");
  });

  it("readPage throws UnknownWikiPageError when neither wiki has a match", async () => {
    await expect(federated.readPage("Nowhere")).rejects.toThrow(UnknownWikiPageError);
  });

  it("resolveLink prefers the project, falls back to the user wiki", async () => {
    await user.upsertPage({
      relPath: "concepts/Personal Habit.md",
      frontmatter: { title: "Personal Habit", type: "concept", tags: [], sources: [] },
      body: "user body",
    });
    expect(await federated.resolveLink("Personal Habit")).toBe("user:concepts/Personal Habit.md");
    expect(await federated.resolveLink("Nowhere")).toBeUndefined();
  });

  it("backlinks finds a project page linking a user-only title", async () => {
    await user.upsertPage({
      relPath: "concepts/Personal Habit.md",
      frontmatter: { title: "Personal Habit", type: "concept", tags: [], sources: [] },
      body: "user body",
    });
    await project.upsertPage({
      relPath: "concepts/Project Thing.md",
      frontmatter: { title: "Project Thing", type: "concept", tags: [], sources: [] },
      body: "See [[Personal Habit]] for more.",
    });

    const backlinks = await federated.backlinks("Personal Habit");
    expect(backlinks).toEqual(["concepts/Project Thing.md"]);
  });
});
