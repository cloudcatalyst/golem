/**
 * R5.5 (spike) — prompt translation + accepted-example style store.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CapabilityUnavailableError,
  type ChatMessage,
  type ChatResult,
  type InferenceService,
  type Role,
} from "../../../src/interfaces/inference.js";
import {
  appendExample,
  readExamples,
  readLastSuggestion,
  translatePrompt,
  writeLastSuggestion,
} from "../../../src/prompt/index.js";
import { rmTemp } from "../../helpers/tmp.js";

function fakeInference(
  text: string,
  capture?: (m: readonly ChatMessage[]) => void,
): InferenceService {
  return {
    chat: (role: Role, m: readonly ChatMessage[]): Promise<ChatResult> => {
      capture?.(m);
      return Promise.resolve({
        text,
        model: "m",
        role,
        promptTokens: 0,
        completionTokens: 0,
        finishReason: "stop",
      });
    },
    embed: () => Promise.resolve([]),
    capabilities: () => 2,
  };
}

describe("translatePrompt", () => {
  it("returns a suggestion (never an action)", async () => {
    const res = await translatePrompt("fix the thing", {
      inference: fakeInference("Fix X in file Y."),
    });
    expect(res.translated).toBe("Fix X in file Y.");
    expect(res.raw).toBe("fix the thing");
  });

  it("grounds on the most recent accepted examples (few-shot)", async () => {
    let seen: readonly ChatMessage[] = [];
    const inference = fakeInference("out", (m) => {
      seen = m;
    });
    await translatePrompt("raw note", {
      inference,
      examples: [
        { raw: "r1", translated: "t1", ts: "a" },
        { raw: "r2", translated: "t2", ts: "b" },
      ],
    });
    // system + 2*(user+assistant) demonstrations + final user.
    const contents = seen.map((m) => String((m as { content?: unknown }).content ?? ""));
    expect(contents).toContain("t2");
    expect(contents[contents.length - 1]).toBe("raw note");
  });

  it("degrades to translated:null when the local model is unavailable", async () => {
    const inference: InferenceService = {
      chat: () => Promise.reject(new CapabilityUnavailableError("drafter", 2)),
      embed: () => Promise.resolve([]),
      capabilities: () => 2,
    };
    const res = await translatePrompt("x", { inference });
    expect(res.translated).toBeNull();
    expect(res.error).toContain("local model unavailable");
  });

  it("treats an empty rewrite as no suggestion (never fabricates)", async () => {
    const res = await translatePrompt("x", { inference: fakeInference("   ") });
    expect(res.translated).toBeNull();
  });
});

describe("style store", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-style-"));
  });
  afterEach(async () => {
    await rm(dir, rmTemp);
  });

  it("round-trips the last suggestion → accepted example", async () => {
    expect(await readLastSuggestion(dir)).toBeNull();
    await writeLastSuggestion(dir, "raw", "translated");
    const last = await readLastSuggestion(dir);
    expect(last).toEqual({ raw: "raw", translated: "translated" });
    await appendExample(dir, {
      ...(last as { raw: string; translated: string }),
      ts: "2026-07-16",
    });
    const examples = await readExamples(dir);
    expect(examples).toHaveLength(1);
    expect(examples[0]?.translated).toBe("translated");
  });

  it("readExamples is empty + non-throwing when nothing is stored", async () => {
    expect(await readExamples(dir)).toEqual([]);
  });
});
