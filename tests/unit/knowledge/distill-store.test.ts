/**
 * T3 (WS-W W3) — zone-1 draft storage: `.golem/distill/<slug>.md`, wiki-page
 * shaped from the start (frontmatter type "source").
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DistillDraft } from "../../../src/knowledge/distill.js";
import {
  distillDir,
  findDraftByUrl,
  listDraftFiles,
  readDraftFile,
  writeDraftFile,
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
