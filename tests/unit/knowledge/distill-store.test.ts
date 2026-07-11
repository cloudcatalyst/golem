/**
 * T3 (WS-W W3) — zone-1 draft storage: `.golem/distill/<slug>.md`, wiki-page
 * shaped from the start (frontmatter type "source").
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DistillDraft, NoteDraft } from "../../../src/knowledge/distill.js";
import {
  distillDir,
  findDraftByNoteTs,
  findDraftByUrl,
  listDraftFiles,
  readDraftFile,
  writeDraftFile,
  writeNoteDraftFile,
} from "../../../src/knowledge/distill-store.js";

let projectDir: string;
beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-distill-"));
});
afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

const url = "https://example.com/widgets";
const draft: DistillDraft = {
  title: "Widget Factory Basics",
  slug: "widget-factory-basics",
  tags: ["widgets", "factory"],
  summary: "Widgets are small rotating gears.",
  wikilinks: ["Widget Factory"],
};

describe("writeDraftFile / readDraftFile", () => {
  it("writes a wiki-shaped draft file with type=source and the URL in sources", async () => {
    const file = await writeDraftFile(projectDir, url, draft, "2026-07-11T00:00:00.000Z");
    expect(file).toBe(path.join(distillDir(projectDir), "widget-factory-basics.md"));

    const raw = await readFile(file, "utf8");
    expect(raw).toContain("type: source");
    expect(raw).toContain(`sources: [${url}]`);
    expect(raw).toContain("Widgets are small rotating gears.");
    expect(raw).toContain("[[Widget Factory]]");

    const read = await readDraftFile(projectDir, "widget-factory-basics");
    expect(read?.frontmatter.title).toBe("Widget Factory Basics");
    expect(read?.frontmatter.sources).toEqual([url]);
    expect(read?.frontmatter.tags).toEqual(["widgets", "factory"]);
  });

  it("strips known secrets from the summary before writing (redaction floor)", async () => {
    // Assembled from fragments so no contiguous PEM header is a literal in
    // this source file (this repo's own Golem proxy would otherwise redact it
    // in tooling views).
    const begin = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    const end = ["-----END", "PRIVATE KEY-----"].join(" ");
    const leaky: DistillDraft = {
      ...draft,
      summary: `notes\n${begin}\nZmFrZWtleWRhdGE=\n${end}\nend`,
    };
    const file = await writeDraftFile(projectDir, url, leaky, "2026-07-11T00:00:00.000Z");
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain("ZmFrZWtleWRhdGE=");
    expect(raw).toContain("[golem:redacted pem-private-key]");
  });

  it("overwrites the same slug on a second write (idempotent by slug)", async () => {
    await writeDraftFile(projectDir, url, draft, "2026-07-11T00:00:00.000Z");
    const updated: DistillDraft = { ...draft, summary: "Updated summary." };
    await writeDraftFile(projectDir, url, updated, "2026-07-11T00:00:01.000Z");
    const drafts = await listDraftFiles(projectDir);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.body).toContain("Updated summary.");
  });

  it("readDraftFile returns null for a missing slug", async () => {
    expect(await readDraftFile(projectDir, "does-not-exist")).toBeNull();
  });
});

describe("listDraftFiles", () => {
  it("returns an empty array when the distill dir doesn't exist yet", async () => {
    expect(await listDraftFiles(projectDir)).toEqual([]);
  });

  it("lists all drafts sorted by slug", async () => {
    await writeDraftFile(
      projectDir,
      "https://example.com/b",
      { ...draft, slug: "b-page", title: "B" },
      "2026-07-11T00:00:00.000Z",
    );
    await writeDraftFile(
      projectDir,
      "https://example.com/a",
      { ...draft, slug: "a-page", title: "A" },
      "2026-07-11T00:00:00.000Z",
    );
    const drafts = await listDraftFiles(projectDir);
    expect(drafts.map((d) => d.slug)).toEqual(["a-page", "b-page"]);
  });
});

describe("findDraftByUrl", () => {
  it("finds a draft citing the given URL", async () => {
    await writeDraftFile(projectDir, url, draft, "2026-07-11T00:00:00.000Z");
    const found = await findDraftByUrl(projectDir, url);
    expect(found?.slug).toBe("widget-factory-basics");
  });

  it("returns null when no draft cites the URL", async () => {
    await writeDraftFile(projectDir, url, draft, "2026-07-11T00:00:00.000Z");
    expect(await findDraftByUrl(projectDir, "https://example.com/other")).toBeNull();
  });
});

const noteTs = "2026-07-12T00:00:00.000Z";
const noteDraft: NoteDraft = {
  title: "Should notes support tagging?",
  slug: "should-notes-support-tagging",
  tags: ["notes"],
  type: "question",
  summary: "Whether captured notes should support inline #tags.",
  wikilinks: [],
};

describe("writeNoteDraftFile / findDraftByNoteTs", () => {
  it("writes a wiki-shaped draft file with the note's type and a note: provenance marker", async () => {
    const file = await writeNoteDraftFile(projectDir, noteTs, noteDraft, noteTs);
    expect(file).toBe(path.join(distillDir(projectDir), "should-notes-support-tagging.md"));

    const raw = await readFile(file, "utf8");
    expect(raw).toContain("type: question");
    expect(raw).toContain(`sources: [note:${noteTs}]`);
    expect(raw).toContain("Whether captured notes should support inline #tags.");
    expect(raw).not.toContain("Source:");

    const read = await readDraftFile(projectDir, "should-notes-support-tagging");
    expect(read?.frontmatter.type).toBe("question");
    expect(read?.frontmatter.sources).toEqual([`note:${noteTs}`]);
  });

  it("finds a draft shaped from the given note timestamp", async () => {
    await writeNoteDraftFile(projectDir, noteTs, noteDraft, noteTs);
    const found = await findDraftByNoteTs(projectDir, noteTs);
    expect(found?.slug).toBe("should-notes-support-tagging");
  });

  it("returns null when no draft cites the note timestamp", async () => {
    await writeNoteDraftFile(projectDir, noteTs, noteDraft, noteTs);
    expect(await findDraftByNoteTs(projectDir, "2026-07-12T01:00:00.000Z")).toBeNull();
  });

  it("keeps note-derived and url-derived drafts distinguishable by provenance marker", async () => {
    await writeDraftFile(projectDir, url, draft, "2026-07-11T00:00:00.000Z");
    await writeNoteDraftFile(projectDir, noteTs, noteDraft, noteTs);
    expect(await findDraftByUrl(projectDir, url)).not.toBeNull();
    expect((await findDraftByUrl(projectDir, url))?.slug).toBe("widget-factory-basics");
    expect(await findDraftByNoteTs(projectDir, noteTs)).not.toBeNull();
    expect((await findDraftByNoteTs(projectDir, noteTs))?.slug).toBe(
      "should-notes-support-tagging",
    );
    // A raw URL never matches a note's `note:<ts>` marker, and vice versa.
    expect(await findDraftByNoteTs(projectDir, url)).toBeNull();
  });
});
