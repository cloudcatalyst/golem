/**
 * Decision 25 (spec v1.8) unit coverage for the local-intercept helpers:
 * Anthropic-message flattening, the escalation heuristic, and the synthetic
 * Anthropic Messages API response builders (non-streaming + SSE), whose
 * shapes are checked against tests/integration/helpers/anthropic-fixtures.ts.
 */

import { describe, expect, it } from "vitest";
import type { ChatResult, InferenceService, Role, Vector } from "../../../src/interfaces/index.js";
import { HardwareTier } from "../../../src/interfaces/index.js";
import {
  appendSystemBlock,
  labelDraft,
  looksLikeEscalation,
  runDraftStage,
  runLocalFirstStage,
  toLocalChatMessages,
} from "../../../src/pipeline/local-intercept.js";

class FakeInferenceService implements InferenceService {
  constructor(private readonly impl: (role: Role) => Promise<ChatResult>) {}

  async chat(role: Role): Promise<ChatResult> {
    return this.impl(role);
  }

  async embed(): Promise<Vector[]> {
    throw new Error("not used by these tests");
  }

  capabilities(): HardwareTier {
    return HardwareTier.PMid;
  }
}

function draft(text: string, model = "qwen2.5-coder:7b"): ChatResult {
  return {
    text,
    model,
    role: "drafter",
    promptTokens: 10,
    completionTokens: 5,
    finishReason: "stop",
  };
}

describe("toLocalChatMessages", () => {
  it("flattens string-content messages and a string system prompt", () => {
    const messages = toLocalChatMessages([{ role: "user", content: "hello" }], "be concise");
    expect(messages).toStrictEqual([
      { role: "system", content: "be concise" },
      { role: "user", content: "hello" },
    ]);
  });

  it("extracts text blocks from array content, dropping tool_use/image blocks", () => {
    const messages = toLocalChatMessages(
      [
        {
          role: "assistant",
          content: [
            { type: "text", text: "checking the file" },
            { type: "tool_use", id: "t1", name: "read_file", input: {} },
          ],
        },
        { role: "user", content: [{ type: "image", source: { type: "base64", data: "..." } }] },
      ],
      undefined,
    );
    expect(messages).toStrictEqual([{ role: "assistant", content: "checking the file" }]);
  });

  it("extracts text out of tool_result blocks (string and array-of-text-block forms)", () => {
    const messages = toLocalChatMessages(
      [
        { role: "user", content: [{ type: "tool_result", content: "file contents here" }] },
        {
          role: "user",
          content: [
            { type: "tool_result", content: [{ type: "text", text: "nested text block" }] },
          ],
        },
      ],
      undefined,
    );
    expect(messages).toStrictEqual([
      { role: "user", content: "file contents here" },
      { role: "user", content: "nested text block" },
    ]);
  });

  it("drops messages that produce no extractable text", () => {
    const messages = toLocalChatMessages(
      [{ role: "user", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] }],
      undefined,
    );
    expect(messages).toStrictEqual([]);
  });

  it("handles a system content-block array (with cache_control)", () => {
    const messages = toLocalChatMessages(
      [],
      [{ type: "text", text: "system prompt", cache_control: { type: "ephemeral" } }],
    );
    expect(messages).toStrictEqual([{ role: "system", content: "system prompt" }]);
  });

  it("returns an empty array for a non-array messages value", () => {
    expect(toLocalChatMessages(undefined, undefined)).toStrictEqual([]);
    expect(toLocalChatMessages("not an array", undefined)).toStrictEqual([]);
  });
});

describe("looksLikeEscalation", () => {
  it("flags common refusal/uncertainty phrasing", () => {
    expect(looksLikeEscalation("I don't have access to the file contents.")).toBe(true);
    expect(looksLikeEscalation("I can't see the file you're referring to.")).toBe(true);
    expect(looksLikeEscalation("As an AI, I'm not able to run code.")).toBe(true);
    expect(looksLikeEscalation("I need to see the file before I can answer.")).toBe(true);
  });

  it("flags empty/whitespace-only text", () => {
    expect(looksLikeEscalation("")).toBe(true);
    expect(looksLikeEscalation("   \n  ")).toBe(true);
  });

  it("does not flag a confident, substantive answer", () => {
    expect(looksLikeEscalation("Use Array.prototype.map to transform the list.")).toBe(false);
  });
});

describe("labelDraft / appendSystemBlock", () => {
  it("labels a draft as unverified with the real local model id", () => {
    const label = labelDraft(draft("use a for loop"));
    expect(label).toContain("qwen2.5-coder:7b");
    expect(label).toContain("unverified");
    expect(label).toContain("use a for loop");
  });

  it("appends to an absent system prompt by returning the text itself", () => {
    expect(appendSystemBlock(undefined, "extra")).toBe("extra");
    expect(appendSystemBlock(null, "extra")).toBe("extra");
  });

  it("appends to a string system prompt", () => {
    expect(appendSystemBlock("be concise", "extra")).toBe("be concise\n\nextra");
  });

  it("appends a text block to an array system prompt, preserving existing blocks", () => {
    const original = [{ type: "text", text: "be concise" }];
    const result = appendSystemBlock(original, "extra");
    expect(result).toStrictEqual([
      { type: "text", text: "be concise" },
      { type: "text", text: "extra" },
    ]);
    // Original array is untouched (no in-place mutation).
    expect(original).toStrictEqual([{ type: "text", text: "be concise" }]);
  });
});

describe("runDraftStage (Mode A)", () => {
  it("returns a labeled draft on success", async () => {
    const inference = new FakeInferenceService(async () => draft("try recursion"));
    const text = await runDraftStage(inference, {
      messages: [{ role: "user", content: "how do I sort this?" }],
    });
    expect(text).toContain("try recursion");
    expect(text).toContain("Local draft");
  });

  it("returns null (fail-open) when inference throws", async () => {
    const inference = new FakeInferenceService(async () => {
      throw new Error("endpoint unreachable");
    });
    const text = await runDraftStage(inference, { messages: [{ role: "user", content: "hi" }] });
    expect(text).toBeNull();
  });

  it("returns null when there are no extractable messages (never calls the model)", async () => {
    let called = false;
    const inference = new FakeInferenceService(async () => {
      called = true;
      return draft("unused");
    });
    const text = await runDraftStage(inference, { messages: [] });
    expect(text).toBeNull();
    expect(called).toBe(false);
  });

  it("returns null when the draft text is empty", async () => {
    const inference = new FakeInferenceService(async () => draft("   "));
    const text = await runDraftStage(inference, { messages: [{ role: "user", content: "hi" }] });
    expect(text).toBeNull();
  });
});

describe("runLocalFirstStage (Mode B)", () => {
  const body = { messages: [{ role: "user", content: "what does Array.map do?" }] };

  it("serves a non-streaming synthetic Anthropic response for a confident draft", async () => {
    const inference = new FakeInferenceService(async () =>
      draft("It creates a new array by applying a function to every element."),
    );
    const outcome = await runLocalFirstStage(inference, body, false);
    expect(outcome.kind).toBe("served");
    if (outcome.kind !== "served") throw new Error("expected served");
    expect(outcome.response.statusCode).toBe(200);
    expect(outcome.response.headers["content-type"]).toBe("application/json");
    const parsed = JSON.parse(outcome.response.body.toString("utf8"));
    expect(parsed.type).toBe("message");
    expect(parsed.role).toBe("assistant");
    expect(parsed.model).toBe("qwen2.5-coder:7b");
    expect(parsed.stop_reason).toBe("end_turn");
    expect(parsed.stop_sequence).toBeNull();
    expect(Array.isArray(parsed.content)).toBe(true);
    expect(parsed.content[0].type).toBe("text");
    expect(parsed.content[0].text).toContain("**Golem** Used qwen2.5-coder:7b locally");
    expect(parsed.content[0].text).toContain("verify independently");
    expect(parsed.content[0].text).toContain("new array");
    expect(parsed.usage).toStrictEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("serves a valid SSE stream (message_start...message_stop) when streaming is requested", async () => {
    const inference = new FakeInferenceService(async () => draft("a straightforward answer"));
    const outcome = await runLocalFirstStage(inference, body, true);
    expect(outcome.kind).toBe("served");
    if (outcome.kind !== "served") throw new Error("expected served");
    expect(outcome.response.headers["content-type"]).toBe("text/event-stream");
    const text = outcome.response.body.toString("utf8");
    const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(events).toStrictEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(text).toContain("a straightforward answer");
    // Every data line must be valid, parseable JSON.
    for (const line of text.split("\n").filter((l) => l.startsWith("data: "))) {
      expect(() => JSON.parse(line.slice("data: ".length))).not.toThrow();
    }
  });

  it("escalates with the rejected draft when the text reads as a refusal", async () => {
    const inference = new FakeInferenceService(async () =>
      draft("I don't have access to the file you're asking about."),
    );
    const outcome = await runLocalFirstStage(inference, body, false);
    expect(outcome).toStrictEqual({
      kind: "escalate",
      draftText: expect.stringContaining("I don't have access") as unknown as string,
    });
  });

  it("escalates with a null draft when inference throws", async () => {
    const inference = new FakeInferenceService(async () => {
      throw new Error("timeout");
    });
    const outcome = await runLocalFirstStage(inference, body, false);
    expect(outcome).toStrictEqual({ kind: "escalate", draftText: null });
  });

  it("escalates with a null draft when there are no extractable messages", async () => {
    const inference = new FakeInferenceService(async () => draft("unused"));
    const outcome = await runLocalFirstStage(inference, { messages: [] }, false);
    expect(outcome).toStrictEqual({ kind: "escalate", draftText: null });
  });

  it("escalates without calling the model when the request declares tools", async () => {
    let called = false;
    const inference = new FakeInferenceService(async () => {
      called = true;
      return draft("Let me read the file: docs/IMPLEMENTATION_PLAN.md");
    });
    const outcome = await runLocalFirstStage(
      inference,
      { ...body, tools: [{ name: "read_file", description: "reads a file", input_schema: {} }] },
      false,
    );
    expect(outcome).toStrictEqual({ kind: "escalate", draftText: null });
    expect(called).toBe(false);
  });

  it("does not escalate on tools alone when the tools array is empty", async () => {
    const inference = new FakeInferenceService(async () =>
      draft("It creates a new array by applying a function to every element."),
    );
    const outcome = await runLocalFirstStage(inference, { ...body, tools: [] }, false);
    expect(outcome.kind).toBe("served");
  });
});
