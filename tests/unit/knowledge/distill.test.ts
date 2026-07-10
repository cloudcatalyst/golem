/**
 * T3 (WS-W W3) — distillPage: local-model summarization into a wiki-shaped
 * source-note draft. Uses a fake InferenceService (no network, no Ollama).
 */

import { describe, expect, it } from "vitest";
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
import { DistillParseError, distillPage } from "../../../src/knowledge/distill.js";

class FakeInferenceService implements InferenceService {
  lastRole: Role | undefined;
  lastMessages: readonly ChatMessage[] | undefined;
  lastOpts: ChatOptions | undefined;

  constructor(private readonly text: string) {}

  async chat(
    role: Role,
    messages: readonly ChatMessage[],
    opts?: ChatOptions,
  ): Promise<ChatResult> {
    this.lastRole = role;
    this.lastMessages = messages;
    this.lastOpts = opts;
    return {
      text: this.text,
      model: "fake-model",
      role,
      promptTokens: 10,
      completionTokens: 10,
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

const input = {
  url: "https://example.com/widgets",
  rawText: "Widgets are small rotating gears used to configure the factory.",
  existingTitles: ["Widget Factory", "Prompt Caching"],
};

describe("distillPage", () => {
  it("calls chat with role summarizer and a jsonSchema, embedding the raw text in the prompt", async () => {
    const draft = {
      title: "Widget Factory Basics",
      slug: "widget-factory-basics",
      tags: ["widgets", "factory"],
      summary: "Widgets are small rotating gears (source: https://example.com/widgets).",
      wikilinks: ["Widget Factory"],
    };
    const fake = new FakeInferenceService(JSON.stringify(draft));
    const result = await distillPage(fake, input);

    expect(fake.lastRole).toBe("summarizer");
    expect(fake.lastOpts?.jsonSchema).toBeDefined();
    const promptText = JSON.stringify(fake.lastMessages);
    expect(promptText).toContain("rotating gears");
    expect(promptText).toContain(input.url);

    expect(result.title).toBe("Widget Factory Basics");
    expect(result.slug).toBe("widget-factory-basics");
    expect(result.tags).toEqual(["widgets", "factory"]);
    expect(result.wikilinks).toEqual(["Widget Factory"]);
  });

  it("normalizes a messy model slug to kebab-case", async () => {
    const draft = {
      title: "Widget Factory Basics",
      slug: "Widget Factory_Basics!!",
      tags: ["widgets"],
      summary: "summary text",
      wikilinks: [],
    };
    const fake = new FakeInferenceService(JSON.stringify(draft));
    const result = await distillPage(fake, input);
    expect(result.slug).toBe("widget-factory-basics");
  });

  it("derives a slug from the title when the model's slug is empty after normalizing", async () => {
    const draft = {
      title: "Widget Factory Basics",
      slug: "!!!",
      tags: ["widgets"],
      summary: "summary text",
      wikilinks: [],
    };
    const fake = new FakeInferenceService(JSON.stringify(draft));
    const result = await distillPage(fake, input);
    expect(result.slug).toBe("widget-factory-basics");
  });

  it("keeps only wikilinks that case-insensitively match an existing title, using canonical casing", async () => {
    const draft = {
      title: "Widget Factory Basics",
      slug: "widget-factory-basics",
      tags: ["widgets"],
      summary: "summary text",
      wikilinks: ["widget FACTORY", "Nonexistent Page", "widget factory"],
    };
    const fake = new FakeInferenceService(JSON.stringify(draft));
    const result = await distillPage(fake, input);
    expect(result.wikilinks).toEqual(["Widget Factory"]);
  });

  it("throws DistillParseError with the raw output on invalid JSON", async () => {
    const fake = new FakeInferenceService("not json at all");
    await expect(distillPage(fake, input)).rejects.toThrow(DistillParseError);
    await expect(distillPage(fake, input)).rejects.toThrow(/not json at all|model response/);
  });

  it("throws DistillParseError when required fields are missing", async () => {
    const fake = new FakeInferenceService(JSON.stringify({ title: "Only a title" }));
    await expect(distillPage(fake, input)).rejects.toThrow(DistillParseError);
  });
});
