/**
 * R3.5 — `golem note distill` engine: distillNoteCapture. Local inference is
 * injected (fake), so no real Ollama is required.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { distillNoteCapture } from "../../../src/cli/distill-note.js";
import { InitError } from "../../../src/cli/init.js";
import { appendNote } from "../../../src/cli/notes.js";
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
import { useTempDirs } from "../../helpers/tmp.js";

class FakeInferenceService implements InferenceService {
  constructor(private readonly draft: Record<string, unknown>) {}

  async chat(
    role: Role,
    _messages: readonly ChatMessage[],
    _opts?: ChatOptions,
  ): Promise<ChatResult> {
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
  title: "Should notes support tagging?",
  slug: "should-notes-support-tagging",
  tags: ["notes"],
  type: "question",
  summary: "Whether captured notes should support inline #tags.",
  wikilinks: [],
};

let projectDir: string;
const newTempDir = useTempDirs("golem-distill-note-cli-");

beforeEach(async () => {
  projectDir = await newTempDir();
});

describe("distillNoteCapture", () => {
  it("throws InitError when no notes have been captured yet", async () => {
    await expect(distillNoteCapture({ projectDir })).rejects.toThrow(InitError);
  });

  it("throws InitError when the given ts doesn't match any captured note", async () => {
    await appendNote(projectDir, "some idea", "2026-07-12T00:00:00.000Z");
    await expect(
      distillNoteCapture({ projectDir, ts: "2026-07-12T09:00:00.000Z" }),
    ).rejects.toThrow(InitError);
  });

  it("distills the most recently captured note when no ts is given", async () => {
    await appendNote(projectDir, "first idea", "2026-07-12T00:00:00.000Z");
    await appendNote(projectDir, "second idea", "2026-07-12T00:00:01.000Z");

    const result = await distillNoteCapture({
      projectDir,
      inference: new FakeInferenceService(fakeDraft),
      nowIso: "2026-07-12T00:00:02.000Z",
    });
    expect(result.kind).toBe("written");
    expect(result.path).toContain("should-notes-support-tagging.md");
  });

  it("distills the note with the given ts", async () => {
    await appendNote(projectDir, "first idea", "2026-07-12T00:00:00.000Z");
    await appendNote(projectDir, "second idea", "2026-07-12T00:00:01.000Z");

    const result = await distillNoteCapture({
      projectDir,
      ts: "2026-07-12T00:00:00.000Z",
      inference: new FakeInferenceService(fakeDraft),
      nowIso: "2026-07-12T00:00:02.000Z",
    });
    expect(result.kind).toBe("written");
  });

  it("returns the existing draft instead of re-distilling, unless forced", async () => {
    await appendNote(projectDir, "first idea", "2026-07-12T00:00:00.000Z");
    const first = await distillNoteCapture({
      projectDir,
      inference: new FakeInferenceService(fakeDraft),
      nowIso: "2026-07-12T00:00:00.000Z",
    });
    expect(first.kind).toBe("written");

    const second = await distillNoteCapture({
      projectDir,
      inference: new FakeInferenceService(fakeDraft),
    });
    expect(second).toEqual({ kind: "exists", path: first.path });
  });

  it("re-distills when force is set even if a draft already exists", async () => {
    await appendNote(projectDir, "first idea", "2026-07-12T00:00:00.000Z");
    await distillNoteCapture({
      projectDir,
      inference: new FakeInferenceService(fakeDraft),
      nowIso: "2026-07-12T00:00:00.000Z",
    });
    const forced = await distillNoteCapture({
      projectDir,
      force: true,
      inference: new FakeInferenceService(fakeDraft),
      nowIso: "2026-07-12T00:00:01.000Z",
    });
    expect(forced.kind).toBe("written");
  });
});
