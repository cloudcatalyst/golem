/**
 * WS-W W2 — FileWikiStore behavior beyond the generic WikiStore contract:
 * date stamping across a changing clock, and the on-disk file shape.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileWikiStore } from "../../../src/wiki/index.js";

let dir: string;
let today: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "golem-wiki-store-"));
  today = "2026-07-10";
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FileWikiStore", () => {
  it("stamps created and updated to the injected clock, keeping created stable across updates", async () => {
    const store = new FileWikiStore({ wikiDir: dir, now: () => today });
    const first = await store.upsertPage({
      relPath: "concepts/Prompt Caching.md",
      frontmatter: { title: "Prompt Caching", type: "concept", tags: [], sources: [] },
      body: "day one",
    });
    expect(first.frontmatter.created).toBe("2026-07-10");
    expect(first.frontmatter.updated).toBe("2026-07-10");

    today = "2026-07-15";
    const second = await store.upsertPage({
      relPath: "concepts/Prompt Caching.md",
      frontmatter: { title: "Prompt Caching", type: "concept", tags: [], sources: [] },
      body: "day two",
    });
    expect(second.frontmatter.created).toBe("2026-07-10");
    expect(second.frontmatter.updated).toBe("2026-07-15");
  });

  it("writes a well-formed frontmatter block + body to disk", async () => {
    const store = new FileWikiStore({ wikiDir: dir, now: () => today });
    await store.upsertPage({
      relPath: "concepts/Prompt Caching.md",
      frontmatter: { title: "Prompt Caching", type: "concept", tags: ["cache"], sources: [] },
      body: "Body text.",
    });
    const raw = await readFile(path.join(dir, "concepts", "Prompt Caching.md"), "utf8");
    expect(raw).toBe(
      [
        "---",
        "title: Prompt Caching",
        "type: concept",
        "tags: [cache]",
        "sources: []",
        "created: 2026-07-10",
        "updated: 2026-07-10",
        "---",
        "",
        "Body text.",
        "",
      ].join("\n"),
    );
  });

  it("creates nested zone directories on demand", async () => {
    const store = new FileWikiStore({ wikiDir: dir, now: () => today });
    await store.upsertPage({
      relPath: "entities/Some Thing.md",
      frontmatter: { title: "Some Thing", type: "entity", tags: [], sources: [] },
      body: "body",
    });
    const page = await store.readPage("entities/Some Thing.md");
    expect(page.frontmatter.title).toBe("Some Thing");
  });

  it("listPages skips unparsable files instead of throwing", async () => {
    const store = new FileWikiStore({ wikiDir: dir, now: () => today });
    await store.upsertPage({
      relPath: "concepts/Good.md",
      frontmatter: { title: "Good", type: "concept", tags: [], sources: [] },
      body: "fine",
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(path.join(dir, "concepts", "Bad.md"), "not frontmatter at all", "utf8");

    await expect(store.resolveLink("Good")).resolves.toBe("concepts/Good.md");
    await expect(store.backlinks("Good")).resolves.toEqual([]);
  });

  it("returns an empty page list (not a throw) when wikiDir does not exist yet", async () => {
    const store = new FileWikiStore({ wikiDir: path.join(dir, "missing"), now: () => today });
    await expect(store.resolveLink("Anything")).resolves.toBeUndefined();
  });
});
