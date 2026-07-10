/**
 * Reusable contract harness for WikiStore implementations (WS-W W2).
 */

import { describe, expect, it } from "vitest";
import type { WikiStore } from "../../src/interfaces/index.js";
import { UnknownWikiPageError, WikiWriteConflictError } from "../../src/interfaces/index.js";

export function describeWikiStoreContract(
  name: string,
  makeStore: () => WikiStore | Promise<WikiStore>,
): void {
  describe(`WikiStore contract: ${name}`, () => {
    it("upsertPage creates a page verbatim when absent", async () => {
      const store = await makeStore();
      const page = await store.upsertPage({
        relPath: "concepts/Prompt Caching.md",
        frontmatter: { title: "Prompt Caching", type: "concept", tags: ["cache"], sources: [] },
        body: "Caching keeps a byte-identical prefix. See [[Wiki-First Knowledge]].",
      });
      expect(page.frontmatter.title).toBe("Prompt Caching");
      expect(page.frontmatter.created).toBe(page.frontmatter.updated);
      expect(page.body).toContain("byte-identical prefix");
    });

    it("readPage finds a page by exact relPath", async () => {
      const store = await makeStore();
      await store.upsertPage({
        relPath: "concepts/Prompt Caching.md",
        frontmatter: { title: "Prompt Caching", type: "concept", tags: [], sources: [] },
        body: "body text",
      });
      const page = await store.readPage("concepts/Prompt Caching.md");
      expect(page.frontmatter.title).toBe("Prompt Caching");
    });

    it("readPage finds a page by title", async () => {
      const store = await makeStore();
      await store.upsertPage({
        relPath: "concepts/Prompt Caching.md",
        frontmatter: { title: "Prompt Caching", type: "concept", tags: [], sources: [] },
        body: "body text",
      });
      const page = await store.readPage("Prompt Caching");
      expect(page.relPath).toBe("concepts/Prompt Caching.md");
    });

    it("readPage rejects with UnknownWikiPageError for an unknown title or path", async () => {
      const store = await makeStore();
      await expect(store.readPage("Nonexistent Page")).rejects.toBeInstanceOf(UnknownWikiPageError);
    });

    it("upsertPage on an existing page appends the body and merges tags/sources", async () => {
      const store = await makeStore();
      const first = await store.upsertPage({
        relPath: "concepts/Prompt Caching.md",
        frontmatter: {
          title: "Prompt Caching",
          type: "concept",
          tags: ["cache"],
          sources: ["a"],
        },
        body: "First note.",
      });
      const second = await store.upsertPage({
        relPath: "concepts/Prompt Caching.md",
        frontmatter: {
          title: "Prompt Caching",
          type: "concept",
          tags: ["cache", "prompts"],
          sources: ["b"],
        },
        body: "Second note.",
      });
      expect(second.body).toContain("First note.");
      expect(second.body).toContain("Second note.");
      expect(second.frontmatter.tags).toEqual(["cache", "prompts"]);
      expect(second.frontmatter.sources).toEqual(["a", "b"]);
      expect(second.frontmatter.created).toBe(first.frontmatter.created);
    });

    it("upsertPage rejects a title mismatch at the same path with WikiWriteConflictError", async () => {
      const store = await makeStore();
      await store.upsertPage({
        relPath: "concepts/Prompt Caching.md",
        frontmatter: { title: "Prompt Caching", type: "concept", tags: [], sources: [] },
        body: "body",
      });
      await expect(
        store.upsertPage({
          relPath: "concepts/Prompt Caching.md",
          frontmatter: { title: "Something Else", type: "concept", tags: [], sources: [] },
          body: "body",
        }),
      ).rejects.toBeInstanceOf(WikiWriteConflictError);
    });

    it("upsertPage rejects a type mismatch at the same path with WikiWriteConflictError", async () => {
      const store = await makeStore();
      await store.upsertPage({
        relPath: "concepts/Prompt Caching.md",
        frontmatter: { title: "Prompt Caching", type: "concept", tags: [], sources: [] },
        body: "body",
      });
      await expect(
        store.upsertPage({
          relPath: "concepts/Prompt Caching.md",
          frontmatter: { title: "Prompt Caching", type: "entity", tags: [], sources: [] },
          body: "body",
        }),
      ).rejects.toBeInstanceOf(WikiWriteConflictError);
    });

    it("resolveLink finds a page's relPath by title, undefined otherwise", async () => {
      const store = await makeStore();
      await store.upsertPage({
        relPath: "concepts/Prompt Caching.md",
        frontmatter: { title: "Prompt Caching", type: "concept", tags: [], sources: [] },
        body: "body",
      });
      await expect(store.resolveLink("Prompt Caching")).resolves.toBe("concepts/Prompt Caching.md");
      await expect(store.resolveLink("Nope")).resolves.toBeUndefined();
    });

    it("backlinks lists pages that wikilink the target title", async () => {
      const store = await makeStore();
      await store.upsertPage({
        relPath: "concepts/Prompt Caching.md",
        frontmatter: { title: "Prompt Caching", type: "concept", tags: [], sources: [] },
        body: "body",
      });
      await store.upsertPage({
        relPath: "concepts/Wiki-First Knowledge.md",
        frontmatter: { title: "Wiki-First Knowledge", type: "concept", tags: [], sources: [] },
        body: "Related: [[Prompt Caching]].",
      });
      await store.upsertPage({
        relPath: "concepts/Unrelated.md",
        frontmatter: { title: "Unrelated", type: "concept", tags: [], sources: [] },
        body: "No links here.",
      });
      const backlinks = await store.backlinks("Prompt Caching");
      expect(backlinks).toEqual(["concepts/Wiki-First Knowledge.md"]);
    });

    it("backlinks returns an empty array for a page with none, and for an unknown page", async () => {
      const store = await makeStore();
      await store.upsertPage({
        relPath: "concepts/Prompt Caching.md",
        frontmatter: { title: "Prompt Caching", type: "concept", tags: [], sources: [] },
        body: "body",
      });
      await expect(store.backlinks("Prompt Caching")).resolves.toEqual([]);
      await expect(store.backlinks("Nonexistent")).resolves.toEqual([]);
    });
  });
}
