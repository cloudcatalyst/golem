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
    expect(out.stream).toBe(true); // b2: the client's stream flag is honored
    expect(out.stream_options).toEqual({ include_usage: true });
    expect(out.max_tokens).toBe(256);
    expect(out.temperature).toBe(0.2);
    expect(out.top_p).toBe(0.9);
    expect(out.stop).toEqual(["STOP"]);
    expect(out.messages).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("flattens content blocks to text (b1 best-effort for tool_result)", () => {
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
    expect(out.messages[0]).toEqual({ role: "user", content: "line one\ntool said x" });
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
});
