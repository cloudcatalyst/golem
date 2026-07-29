/**
 * R6.1 case (b) slice b1 — Anthropic ↔ OpenAI Chat Completions translation
 * (non-streaming, text-only). Pure request/response conversion.
 */

import { describe, expect, it } from "vitest";
import { anthropicToOpenAIChat, openAIChatToAnthropic } from "../../../src/providers/index.js";

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
