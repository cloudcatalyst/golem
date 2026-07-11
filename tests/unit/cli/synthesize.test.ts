/**
 * R3.4 — `golem wiki synthesize` engine: synthesizeWeeklyReport. Local
 * inference is injected (fake), so no real Ollama is required.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InitError } from "../../../src/cli/init.js";
import { appendNote } from "../../../src/cli/notes.js";
import { synthesizeWeeklyReport } from "../../../src/cli/synthesize.js";
import { resolveWikiDir } from "../../../src/cli/wiki.js";
import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  HardwareTier,
  InferenceService,
  Role,
  Vector,
} from "../../../src/interfaces/inference.js";
import { HardwareTier as Tier } from "../../../src/interfaces/inference.js";
import { FileWikiStore } from "../../../src/wiki/index.js";

class FakeInferenceService implements InferenceService {
  lastMessages: readonly ChatMessage[] | undefined;

  constructor(private readonly draft: Record<string, unknown>) {}

  async chat(
    role: Role,
    messages: readonly ChatMessage[],
    _opts?: ChatOptions,
  ): Promise<ChatResult> {
    this.lastMessages = messages;
    return {
      text: JSON.stringify(this.draft),
      model: "fake-model",
      role,
      promptTokens: 1,
      completionTokens: 1,
      finishReason: "stop",
    };
  }

  async embed(): Promise<Vector[]> {
    throw new Error("not used by these tests");
  }

  capabilities(): HardwareTier {
    return Tier.PMid;
  }
}

const fakeDraft = {
  title: "Week of 2026-07-07 synthesis",
  slug: "week-of-2026-07-07-synthesis",
  tags: ["synthesis"],
  summary: "This week's thread: chunking quality work paid off.",
  wikilinks: [],
};

let projectDir: string;
beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-synthesize-cli-"));
});
afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

async function writeDebrief(created: string, title: string, body: string): Promise<void> {
  const wikiDir = resolveWikiDir(projectDir, "docs/wiki");
  const wiki = new FileWikiStore({ wikiDir, now: () => created });
  await wiki.upsertPage({
    relPath: `debriefs/${title}.md`,
    frontmatter: { title, type: "debrief", tags: [], sources: [] },
    body,
  });
}

describe("synthesizeWeeklyReport", () => {
  it("throws InitError when there are no debriefs or notes in the window", async () => {
    await expect(
      synthesizeWeeklyReport({ projectDir, nowIso: "2026-07-12T00:00:00.000Z" }),
    ).rejects.toThrow(InitError);
  });

  it("gathers recent debriefs and notes and writes a synthesis draft", async () => {
    await writeDebrief("2026-07-10", "R3.3 debrief", "Shipped tree-sitter chunking.");
    await appendNote(projectDir, "Should widgets rotate faster?", "2026-07-09T10:00:00.000Z");

    const fake = new FakeInferenceService(fakeDraft);
    const result = await synthesizeWeeklyReport({
      projectDir,
      inference: fake,
      nowIso: "2026-07-12T00:00:00.000Z",
    });

    expect(result.path).toContain("week-of-2026-07-07-synthesis.md");
    expect(result.debriefCount).toBe(1);
    expect(result.noteCount).toBe(1);
    const promptText = JSON.stringify(fake.lastMessages);
    expect(promptText).toContain("tree-sitter chunking");
    expect(promptText).toContain("rotate faster");
  });

  it("excludes debriefs and notes older than the day window", async () => {
    await writeDebrief("2025-01-01", "Ancient debrief", "Old stuff.");
    await appendNote(projectDir, "an old idea", "2025-01-01T00:00:00.000Z");
    await appendNote(projectDir, "a fresh idea", "2026-07-11T00:00:00.000Z");

    const fake = new FakeInferenceService(fakeDraft);
    const result = await synthesizeWeeklyReport({
      projectDir,
      inference: fake,
      days: 7,
      nowIso: "2026-07-12T00:00:00.000Z",
    });

    expect(result.debriefCount).toBe(0);
    expect(result.noteCount).toBe(1);
    const promptText = JSON.stringify(fake.lastMessages);
    expect(promptText).not.toContain("Old stuff");
    expect(promptText).not.toContain("an old idea");
    expect(promptText).toContain("a fresh idea");
  });
});
