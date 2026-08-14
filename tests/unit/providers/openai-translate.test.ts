/**
 * R6.1 case (b) slice b1 — Anthropic ↔ OpenAI Chat Completions translation
 * (non-streaming, text-only). Pure request/response conversion.
 */

import { describe, expect, it } from "vitest";
import {
  anthropicToOpenAIChat,
  countAnthropicInputTokens,
  countTokensResponse,
  openAIChatToAnthropic,
} from "../../../src/providers/index.js";

const buf = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8");

describe("anthropicToOpenAIChat", () => {
  it("maps system + messages, forces stream off, carries params", () => {
    const out = anthropicToOpenAIChat(
      buf({
        model: "claude-sonnet-4-5",
        system: "be terse",
        max_tokens: 256,
        temperature: 0.2,
        top_p: 0.9,
        stop_sequences: ["STOP"],
        stream: true,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
      }),
      { model: "qwen2.5-coder:7b" },
    );
    expect(out.model).toBe("qwen2.5-coder:7b"); // override wins (Ollama has no claude-*)
  });

  it("strips a vendor prefix from the override model", () => {
    const out = anthropicToOpenAIChat(
      buf({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] }),
      { model: "moonshotai/kimi-k2.7-code" },
    );
    expect(out.model).toBe("kimi-k2.7-code");
  });

  it("keeps the vendor prefix when the upstream requires it (keepVendorPrefix)", () => {
    // OpenRouter's canonical id IS `vendor/model` (Decision 48). Stripping it sent
    // `laguna-s-2.1:free` upstream — a different id from the one configured, which
    // either 400s or resolves to another vendor's model of the same name.
    const out = anthropicToOpenAIChat(
      buf({ model: "claude-opus-5[1m]", messages: [{ role: "user", content: "hi" }] }),
      { model: "poolside/laguna-s-2.1:free", keepVendorPrefix: true },
    );
    expect(out.model).toBe("poolside/laguna-s-2.1:free");
  });

  it("splits a user turn's text and tool_result into separate messages (b3)", () => {
    const out = anthropicToOpenAIChat(
      buf({
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "line one" },
              { type: "tool_result", tool_use_id: "t1", content: "tool said x" },
            ],
          },
        ],
      }),
    );
    // tool_result → role:tool (emitted first, answering the prior tool call);
    // text → role:user.
    expect(out.messages).toEqual([
      { role: "tool", tool_call_id: "t1", content: "tool said x" },
      { role: "user", content: "line one" },
    ]);
  });

  it("accepts mid-conversation system messages → OpenAI system messages", () => {
    // Anthropic allows role:"system" inside the messages array (not just the
    // top-level `system` field); Claude Code sends them. Must not be rejected.
    const out = anthropicToOpenAIChat(
      buf({
        model: "kimi-k3",
        system: "top-level system",
        messages: [
          { role: "user", content: "hi" },
          { role: "system", content: "mid-conversation steer" },
          { role: "assistant", content: "ok" },
        ],
      }),
    );
    expect(out.messages).toEqual([
      { role: "system", content: "top-level system" },
      { role: "user", content: "hi" },
      { role: "system", content: "mid-conversation steer" },
      { role: "assistant", content: "ok" },
    ]);
  });

  it("uses the request model when no override is given", () => {
    const out = anthropicToOpenAIChat(buf({ model: "gpt-5.2", messages: [] }));
    expect(out.model).toBe("gpt-5.2");
  });

  it("throws when there is no model (neither override nor request)", () => {
    expect(() => anthropicToOpenAIChat(buf({ messages: [] }))).toThrow(/upstream model/);
  });

  it("throws on an empty body", () => {
    expect(() => anthropicToOpenAIChat(null)).toThrow();
  });
});

describe("openAIChatToAnthropic", () => {
  const fallback = { id: "msg_x", model: "fallback-model" };

  it("maps a completion to an Anthropic message, reporting the real serving model", () => {
    const out = openAIChatToAnthropic(
      buf({
        id: "chatcmpl-1",
        model: "qwen2.5-coder:7b",
        choices: [{ message: { role: "assistant", content: "the answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 5 },
      }),
      fallback,
    );
    expect(out).toEqual({
      id: "chatcmpl-1",
      type: "message",
      role: "assistant",
      model: "qwen2.5-coder:7b", // real serving model, never a claude-* name
      content: [{ type: "text", text: "the answer" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 5 },
    });
  });

  it("maps finish_reason to stop_reason", () => {
    const reason = (finish: string) =>
      openAIChatToAnthropic(
        buf({ choices: [{ message: { content: "x" }, finish_reason: finish }] }),
        fallback,
      ).stop_reason;
    expect(reason("length")).toBe("max_tokens");
    expect(reason("tool_calls")).toBe("tool_use");
    expect(reason("stop")).toBe("end_turn");
    expect(reason("content_filter")).toBe("end_turn");
  });

  it("tolerates a missing content / usage and falls back to id+model", () => {
    const out = openAIChatToAnthropic(
      buf({ choices: [{ message: { role: "assistant", content: null } }] }),
      fallback,
    );
    expect(out.id).toBe("msg_x");
    expect(out.model).toBe("fallback-model");
    expect(out.content).toEqual([{ type: "text", text: "" }]);
    expect(out.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it("throws on a response with no choices", () => {
    expect(() => openAIChatToAnthropic(buf({ choices: [] }), fallback)).toThrow();
  });

  it("maps response tool_calls to Anthropic tool_use blocks (b3)", () => {
    const out = openAIChatToAnthropic(
      buf({
        id: "c1",
        model: "m",
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call_1", function: { name: "get_weather", arguments: '{"city":"SF"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
      fallback,
    );
    expect(out.stop_reason).toBe("tool_use");
    expect(out.content).toEqual([
      { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SF" } },
    ]);
  });

  it("keeps leading text before tool_use, and defaults bad JSON args to {}", () => {
    const out = openAIChatToAnthropic(
      buf({
        choices: [
          {
            message: {
              content: "let me check",
              tool_calls: [{ id: "c2", function: { name: "f", arguments: "not json" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
      fallback,
    );
    expect(out.content).toEqual([
      { type: "text", text: "let me check" },
      { type: "tool_use", id: "c2", name: "f", input: {} },
    ]);
  });
});

describe("tool-use request mapping (b3)", () => {
  it("maps tools and tool_choice", () => {
    const schema = { type: "object", properties: { city: { type: "string" } } };
    const auto = anthropicToOpenAIChat(
      buf({
        model: "m",
        tools: [{ name: "get_weather", description: "Get weather", input_schema: schema }],
        tool_choice: { type: "auto" },
        messages: [{ role: "user", content: "weather?" }],
      }),
    );
    expect(auto.tools).toEqual([
      {
        type: "function",
        function: { name: "get_weather", description: "Get weather", parameters: schema },
      },
    ]);
    expect(auto.tool_choice).toBe("auto");

    const choice = (tc: unknown) =>
      anthropicToOpenAIChat(buf({ model: "m", tool_choice: tc, messages: [] })).tool_choice;
    expect(choice({ type: "any" })).toBe("required");
    expect(choice({ type: "none" })).toBe("none");
    expect(choice({ type: "tool", name: "get_weather" })).toEqual({
      type: "function",
      function: { name: "get_weather" },
    });
  });

  it("passes reasoning_effort through when set (b4-kimi)", () => {
    expect(
      anthropicToOpenAIChat(buf({ model: "m", messages: [] }), {
        model: "kimi-k3",
        reasoningEffort: "high",
      }).reasoning_effort,
    ).toBe("high");
    expect(
      anthropicToOpenAIChat(buf({ model: "m", messages: [] })).reasoning_effort,
    ).toBeUndefined();
  });

  it("expands tool_use → assistant tool_calls and tool_result → role:tool", () => {
    const out = anthropicToOpenAIChat(
      buf({
        model: "m",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "let me check" },
              { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "SF" } },
            ],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "72F" }] },
        ],
      }),
    );
    expect(out.messages).toEqual([
      {
        role: "assistant",
        content: "let me check",
        tool_calls: [
          {
            id: "tu_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"SF"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "tu_1", content: "72F" },
    ]);
  });
});

describe("vision passthrough (b4-kimi)", () => {
  it("maps a base64 image block to an OpenAI image_url data URI, alongside text", () => {
    const out = anthropicToOpenAIChat(
      buf({
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            ],
          },
        ],
      }),
    );
    expect(out.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    });
  });

  it("passes a URL image through and drops an unsupported file source", () => {
    const url = anthropicToOpenAIChat(
      buf({
        model: "m",
        messages: [
          {
            role: "user",
            content: [{ type: "image", source: { type: "url", url: "https://x/y.png" } }],
          },
        ],
      }),
    );
    expect(url.messages[0]?.content).toEqual([
      { type: "image_url", image_url: { url: "https://x/y.png" } },
    ]);

    // A Files-API `file` source has no OpenAI equivalent → dropped; text stays a string.
    const file = anthropicToOpenAIChat(
      buf({
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hi" },
              { type: "image", source: { type: "file", file_id: "f1" } },
            ],
          },
        ],
      }),
    );
    expect(file.messages[0]).toEqual({ role: "user", content: "hi" });
  });
});

describe("reasoning_content → thinking (b4-kimi)", () => {
  const fallback = { id: "msg_x", model: "kimi-k3" };
  it("prepends a thinking block before the text (non-streaming)", () => {
    const out = openAIChatToAnthropic(
      buf({
        choices: [
          {
            message: { reasoning_content: "let me reason", content: "the answer" },
            finish_reason: "stop",
          },
        ],
      }),
      fallback,
    );
    expect(out.content).toEqual([
      { type: "thinking", thinking: "let me reason" },
      { type: "text", text: "the answer" },
    ]);
  });

  it("suppresses the thinking block when mapReasoning is false", () => {
    const out = openAIChatToAnthropic(
      buf({
        choices: [{ message: { reasoning_content: "r", content: "a" }, finish_reason: "stop" }],
      }),
      fallback,
      { mapReasoning: false },
    );
    expect(out.content).toEqual([{ type: "text", text: "a" }]);
  });
});

/**
 * R10.14 — images. Claude Code's `Read` of a `.png` returns an image block
 * INSIDE a tool_result. Before this, a non-text block fell through to
 * `JSON.stringify`, so a 500 KB screenshot reached the model as base64 prose:
 * three of them made one real conversation ~468k tokens and the model answered
 * with nothing at all.
 */
describe("anthropicToOpenAIChat — images (R10.14)", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUg";
  const imageBlock = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: PNG },
  };
  const withToolImage = {
    model: "m",
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.png" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: [imageBlock] }],
      },
    ],
  };

  it("hoists a tool_result image into a following user turn when the model has vision", () => {
    const out = anthropicToOpenAIChat(buf(withToolImage), { model: "m", vision: true });
    const tool = out.messages.find((m) => m.role === "tool");
    // The tool message answers its call and carries NO base64.
    expect(tool?.tool_call_id).toBe("t1");
    expect(String(tool?.content)).not.toContain(PNG);
    expect(String(tool?.content)).toContain("[image:");
    // The image itself rides in a user turn AFTER the tool message.
    const toolIdx = out.messages.findIndex((m) => m.role === "tool");
    const userIdx = out.messages.findIndex(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some((p) => p.type === "image_url"),
    );
    expect(userIdx).toBeGreaterThan(toolIdx);
    const parts = out.messages[userIdx]?.content;
    expect(Array.isArray(parts) && parts.some((p) => p.type === "image_url")).toBe(true);
  });

  it("replaces a tool_result image with a placeholder when the model has no vision", () => {
    const out = anthropicToOpenAIChat(buf(withToolImage), { model: "m", vision: false });
    const serialized = JSON.stringify(out);
    // The whole point: the base64 never reaches the model, in any form.
    expect(serialized).not.toContain(PNG);
    expect(serialized).not.toContain("image_url");
    const tool = out.messages.find((m) => m.role === "tool");
    expect(String(tool?.content)).toContain("no vision support");
  });

  it("forwards a tool_result image when capability is unknown, so the upstream can say so", () => {
    // Guessing "no vision" would silently blind a model that can see; forwarding
    // to one that cannot returns a clean 404 naming the problem.
    const out = anthropicToOpenAIChat(buf(withToolImage), { model: "m" });
    expect(JSON.stringify(out)).toContain("image_url");
  });

  it("never serializes an image block as JSON prose (the actual defect)", () => {
    for (const vision of [true, false, undefined]) {
      const out = anthropicToOpenAIChat(buf(withToolImage), { model: "m", vision });
      const tool = out.messages.find((m) => m.role === "tool");
      expect(String(tool?.content)).not.toContain('"base64"');
    }
  });

  it("replaces a top-level user image with a placeholder when the model has no vision", () => {
    const out = anthropicToOpenAIChat(
      buf({ model: "m", messages: [{ role: "user", content: [imageBlock] }] }),
      { model: "m", vision: false },
    );
    expect(JSON.stringify(out)).not.toContain(PNG);
    expect(String(out.messages.at(-1)?.content)).toContain("[image omitted:");
  });

  it("gives a thinking-only assistant turn empty content, never null", () => {
    // `{role:"assistant", content:null}` with no tool_calls is malformed for
    // OpenAI-compatible endpoints; 22 such turns sat in one real transcript.
    const out = anthropicToOpenAIChat(
      buf({
        model: "m",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "s" }] },
          { role: "user", content: "again" },
        ],
      }),
      { model: "m" },
    );
    const assistant = out.messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("");
    expect(assistant?.content).not.toBeNull();
  });
});

/** R10.15 — count_tokens has no OpenAI equivalent, so it is answered locally. */
describe("countTokensResponse (R10.15)", () => {
  it("returns an Anthropic-shaped input_tokens body and nothing else", () => {
    const out = JSON.parse(
      countTokensResponse(
        buf({ model: "m", system: "be terse", messages: [{ role: "user", content: "hello" }] }),
      ).toString("utf8"),
    );
    expect(Object.keys(out)).toEqual(["input_tokens"]);
    expect(out.input_tokens).toBeGreaterThan(0);
  });

  it("counts system, messages and tool definitions", () => {
    const bare = countAnthropicInputTokens(
      buf({ model: "m", messages: [{ role: "user", content: "hello" }] }),
    );
    const withTools = countAnthropicInputTokens(
      buf({
        model: "m",
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "Bash",
            description: "run a command",
            input_schema: { type: "object", properties: { command: { type: "string" } } },
          },
        ],
      }),
    );
    expect(withTools).toBeGreaterThan(bare);
  });

  it("counts the image placeholder, not the base64 it replaced", () => {
    const withImage = countAnthropicInputTokens(
      buf({
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "A".repeat(400_000) },
              },
            ],
          },
        ],
      }),
    );
    // Counted as text the 400 KB payload would be ~100k tokens. An image is
    // billed by pixel area, not encoded length, so it gets a nominal estimate.
    expect(withImage).toBeLessThan(5_000);
  });

  it("throws on an empty body so the caller can fail cleanly", () => {
    expect(() => countAnthropicInputTokens(null)).toThrow(/empty request body/);
  });
});
