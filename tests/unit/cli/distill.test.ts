/**
 * T3 (WS-W W3) — `golem wiki distill` engine: distillOne / pendingDrafts.
 * Local inference is injected (fake), so no real Ollama is required.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { distillOne, pendingDrafts, renderPendingDrafts } from "../../../src/cli/distill.js";
import { InitError } from "../../../src/cli/init.js";
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
import { WebCache, webCacheDir } from "../../../src/knowledge/index.js";
import { rmTemp } from "../../helpers/tmp.js";

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
  title: "Widget Factory Basics",
  slug: "widget-factory-basics",
  tags: ["widgets"],
  summary: "Widgets are small rotating gears.",
  wikilinks: [],
};

let projectDir: string;
beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-distill-cli-"));
});
afterEach(async () => {
  await rm(projectDir, rmTemp);
});

describe("distillOne", () => {
  it("throws InitError when the URL isn't cached yet", async () => {
    await expect(
      distillOne({ projectDir, url: "https://example.com/never-fetched" }),
    ).rejects.toThrow(InitError);
  });

  it("distills a cached URL using the injected inference service", async () => {
    const url = "https://example.com/widgets";
    await new WebCache(webCacheDir(projectDir)).put(
      url,
      "Widgets are small rotating gears used to configure the factory.",
      "2026-07-11T00:00:00.000Z",
    );

    const result = await distillOne({
      projectDir,
      url,
      inference: new FakeInferenceService(fakeDraft),
      nowIso: "2026-07-11T00:00:00.000Z",
    });
    expect(result.kind).toBe("written");
    expect(result.path).toContain("widget-factory-basics.md");
  });

  it("returns the existing draft instead of re-distilling, unless forced", async () => {
    const url = "https://example.com/widgets";
    await new WebCache(webCacheDir(projectDir)).put(url, "content", "2026-07-11T00:00:00.000Z");
    const first = await distillOne({
      projectDir,
      url,
      inference: new FakeInferenceService(fakeDraft),
      nowIso: "2026-07-11T00:00:00.000Z",
    });
    expect(first.kind).toBe("written");

    const second = await distillOne({
      projectDir,
      url,
      inference: new FakeInferenceService(fakeDraft),
    });
    expect(second).toEqual({ kind: "exists", path: first.path });
  });

  it("re-distills when force is set even if a draft already exists", async () => {
    const url = "https://example.com/widgets";
    await new WebCache(webCacheDir(projectDir)).put(url, "content", "2026-07-11T00:00:00.000Z");
    await distillOne({
      projectDir,
      url,
      inference: new FakeInferenceService(fakeDraft),
      nowIso: "2026-07-11T00:00:00.000Z",
    });
    const forced = await distillOne({
      projectDir,
      url,
      force: true,
      inference: new FakeInferenceService(fakeDraft),
      nowIso: "2026-07-11T00:00:01.000Z",
    });
    expect(forced.kind).toBe("written");
  });
});

describe("pendingDrafts / renderPendingDrafts", () => {
  it("reports no drafts pending when the distill dir is empty", async () => {
    expect(await pendingDrafts(projectDir)).toEqual([]);
    expect(renderPendingDrafts([])).toContain("No distill drafts pending review");
  });

  it("lists a drafted page", async () => {
    const url = "https://example.com/widgets";
    await new WebCache(webCacheDir(projectDir)).put(url, "content", "2026-07-11T00:00:00.000Z");
    await distillOne({
      projectDir,
      url,
      inference: new FakeInferenceService(fakeDraft),
      nowIso: "2026-07-11T00:00:00.000Z",
    });
    const drafts = await pendingDrafts(projectDir);
    expect(drafts).toHaveLength(1);
    expect(renderPendingDrafts(drafts)).toContain("widget-factory-basics");
  });
});
