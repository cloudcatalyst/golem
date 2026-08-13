/**
 * R4.5 — `golem wiki promote`: routes a distill draft to its zone, writes it
 * through append-and-refine, consumes the draft, and enforces the Decision 26
 * consent convention (non-TTY refuses without --yes).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  draftTargetRelPath,
  listPendingPromotions,
  PromoteRefusedError,
  renderPendingPromotions,
  runPromote,
} from "../../../src/cli/promote.js";
import type { NoteDraft } from "../../../src/knowledge/distill.js";
import { readDraftFile, writeNoteDraftFile } from "../../../src/knowledge/distill-store.js";
import { FileWikiStore } from "../../../src/wiki/index.js";
import { useTempDirs } from "../../helpers/tmp.js";

let projectDir: string;
let wikiDir: string;
const NOW = "2026-07-16T12:00:00.000Z";

const newTempDir = useTempDirs("golem-promote-");

beforeEach(async () => {
  projectDir = await newTempDir();
  wikiDir = path.join(projectDir, "docs", "wiki");
});

const questionDraft: NoteDraft = {
  title: "Should promotion archive or delete drafts?",
  slug: "promotion-archive-or-delete",
  type: "question",
  tags: ["planning"],
  summary: "A question captured from a note.",
  wikilinks: ["Distillation Pipeline"],
};

async function seedDraft(): Promise<string> {
  await writeNoteDraftFile(projectDir, "2026-07-16T00:00:00.000Z", questionDraft, NOW);
  return questionDraft.slug;
}

describe("draftTargetRelPath", () => {
  it("routes each type to its zone directory", async () => {
    const slug = await seedDraft();
    const draft = await readDraftFile(projectDir, slug);
    if (draft === null) throw new Error("expected draft");
    expect(draftTargetRelPath(draft)).toBe("questions/promotion-archive-or-delete.md");
  });
});

describe("runPromote", () => {
  it("creates the wiki page from the draft and consumes the draft", async () => {
    const slug = await seedDraft();
    const outcome = await runPromote({ projectDir, wikiDir, slug, nowIso: NOW, yes: true });

    expect(outcome).toMatchObject({
      kind: "promoted",
      relPath: "questions/promotion-archive-or-delete.md",
      created: true,
    });
    // The page exists with the draft's title/type and body.
    const store = new FileWikiStore({ wikiDir });
    const page = await store.readPage("questions/promotion-archive-or-delete.md");
    expect(page.frontmatter.title).toBe(questionDraft.title);
    expect(page.frontmatter.type).toBe("question");
    expect(page.body).toContain("A question captured from a note.");
    // The draft is gone.
    expect(await readDraftFile(projectDir, slug)).toBeNull();
    expect(await listPendingPromotions(projectDir)).toHaveLength(0);
  });

  it("appends (append-and-refine) when the target page already exists", async () => {
    const slug = await seedDraft();
    // Pre-create the page with an existing body.
    const store = new FileWikiStore({ wikiDir, now: () => "2026-07-15" });
    await store.upsertPage({
      relPath: "questions/promotion-archive-or-delete.md",
      frontmatter: {
        title: questionDraft.title,
        type: "question",
        tags: ["prior"],
        sources: ["note:earlier"],
      },
      body: "EXISTING BODY",
    });

    const outcome = await runPromote({ projectDir, wikiDir, slug, nowIso: NOW, yes: true });
    expect(outcome).toMatchObject({ kind: "promoted", created: false });

    const raw = await readFile(
      path.join(wikiDir, "questions", "promotion-archive-or-delete.md"),
      "utf8",
    );
    // Both the old body and the promoted body, under a dated separator; tags unioned.
    expect(raw).toContain("EXISTING BODY");
    expect(raw).toContain("A question captured from a note.");
    expect(raw).toContain("\n---\n");
    expect(raw).toContain("prior");
    expect(raw).toContain("planning");
  });

  it("refuses in a non-interactive session without --yes (Decision 26)", async () => {
    const slug = await seedDraft();
    await expect(
      runPromote({ projectDir, wikiDir, slug, nowIso: NOW, yes: false, isTTY: false }),
    ).rejects.toBeInstanceOf(PromoteRefusedError);
    // Nothing was written or consumed.
    expect(await readDraftFile(projectDir, slug)).not.toBeNull();
  });

  it("cancels (leaving the draft) when a TTY user declines", async () => {
    const slug = await seedDraft();
    const outcome = await runPromote({
      projectDir,
      wikiDir,
      slug,
      nowIso: NOW,
      yes: false,
      isTTY: true,
      confirm: async () => false,
      onPreview: () => {},
    });
    expect(outcome).toStrictEqual({ kind: "cancelled" });
    expect(await readDraftFile(projectDir, slug)).not.toBeNull();
  });

  it("promotes when a TTY user confirms", async () => {
    const slug = await seedDraft();
    let previewed = "";
    const outcome = await runPromote({
      projectDir,
      wikiDir,
      slug,
      nowIso: NOW,
      yes: false,
      isTTY: true,
      confirm: async () => true,
      onPreview: (t) => {
        previewed = t;
      },
    });
    expect(outcome.kind).toBe("promoted");
    expect(previewed).toContain(questionDraft.title);
    expect(await readDraftFile(projectDir, slug)).toBeNull();
  });

  it("throws for an unknown draft id", async () => {
    await expect(
      runPromote({ projectDir, wikiDir, slug: "no-such-draft", nowIso: NOW, yes: true }),
    ).rejects.toThrow(/no pending draft/);
  });
});

describe("renderPendingPromotions", () => {
  it("lists id, target, provenance, and age; friendly message when empty", async () => {
    expect(renderPendingPromotions([], NOW)).toContain("No pending distill drafts");
    await seedDraft();
    const drafts = await listPendingPromotions(projectDir);
    const rendered = renderPendingPromotions(drafts, NOW);
    expect(rendered).toContain("promotion-archive-or-delete");
    expect(rendered).toContain("questions/promotion-archive-or-delete.md");
    expect(rendered).toContain("note:2026-07-16T00:00:00.000Z");
  });
});
