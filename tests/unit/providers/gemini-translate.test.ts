/**
 * R6.1 case (b) slice b4-gemini — Anthropic ↔ Gemini generateContent translation
 * (non-streaming). Request/response conversion + path building.
 */

import { describe, expect, it } from "vitest";
import { anthropicToGemini, geminiPath, geminiToAnthropic } from "../../../src/providers/index.js";

const buf = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8");
const BASE = "https://generativelanguage.googleapis.com/v1beta";

describe("geminiPath", () => {
  it("builds the model+method path, alt=sse for streaming, and the ?key= credential", () => {
    expect(geminiPath(BASE, "gemini-2.0-flash", false, "KEY")).toBe(
      "/v1beta/models/gemini-2.0-flash:generateContent?key=KEY",
    );
    expect(geminiPath(BASE, "gemini-2.0-flash", true, "KEY")).toBe(
      "/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=KEY",
    );
    // No key → no key param (proxy warns elsewhere).
    expect(geminiPath(BASE, "m", false, undefined)).toBe("/v1beta/models/m:generateContent");
  });
});

describe("anthropicToGemini", () => {
  it("maps contents, system, generationConfig, tools, tool_choice and tool round-trips", () => {
    const { body, stream, model } = anthropicToGemini(
      buf({
        model: "claude-x",
        max_tokens: 100,
        temperature: 0.5,
        top_p: 0.9,
        stop_sequences: ["S"],
        system: "be nice",
        tools: [{ name: "get_weather", description: "w", input_schema: { type: "object" } }],
        tool_choice: { type: "auto" },
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "calling" },
              { type: "tool_use", id: "tu1", name: "get_weather", input: { city: "SF" } },
            ],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "72F" }] },
        ],
      }),
      { model: "gemini-2.0-flash" },
    );
    expect(model).toBe("gemini-2.0-flash");
    expect(stream).toBe(false);
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      {
        role: "model", // assistant → model
        parts: [
          { text: "calling" },
          { functionCall: { name: "get_weather", args: { city: "SF" } } },
        ],
      },
      {
        role: "user",
        // tool_result → functionResponse; name recovered from the tu1 tool_use.
        parts: [{ functionResponse: { name: "get_weather", response: { content: "72F" } } }],
      },
    ]);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "be nice" }] });
    expect(body.generationConfig).toEqual({
      maxOutputTokens: 100,
      temperature: 0.5,
      topP: 0.9,
      stopSequences: ["S"],
    });
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          { name: "get_weather", description: "w", parameters: { type: "object" } },
        ],
      },
    ]);
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
  });

  it("maps tool_choice variants", () => {
    const cfg = (tc: unknown) =>
      anthropicToGemini(buf({ model: "m", tool_choice: tc, messages: [] })).body.toolConfig;
    expect(cfg({ type: "any" })).toEqual({ functionCallingConfig: { mode: "ANY" } });
    expect(cfg({ type: "none" })).toEqual({ functionCallingConfig: { mode: "NONE" } });
    expect(cfg({ type: "tool", name: "f" })).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["f"] },
    });
  });

  it("folds a mid-conversation system message into a user turn (Gemini has no system role)", () => {
    const { body } = anthropicToGemini(
      buf({
        model: "gemini-2.0-flash",
        messages: [
          { role: "user", content: "hi" },
          { role: "system", content: "steer" },
        ],
      }),
    );
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "user", parts: [{ text: "steer" }] },
    ]);
  });

  it("throws without a model, and on an empty body", () => {
    expect(() => anthropicToGemini(buf({ messages: [] }))).toThrow(/upstream model/);
    expect(() => anthropicToGemini(null)).toThrow();
  });
});

describe("geminiToAnthropic", () => {
  const fallback = { id: "msg_x", model: "fb" };

  it("maps parts (text + functionCall) to Anthropic blocks with tool_use stop_reason", () => {
    const out = geminiToAnthropic(
      buf({
        responseId: "r1",
        modelVersion: "gemini-2.0-flash",
        candidates: [
          {
            content: {
              parts: [{ text: "hello" }, { functionCall: { name: "f", args: { a: 1 } } }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
      }),
      fallback,
    );
    expect(out).toEqual({
      id: "r1",
      type: "message",
      role: "assistant",
      model: "gemini-2.0-flash", // real serving model
      content: [
        { type: "text", text: "hello" },
        { type: "tool_use", id: "call_0", name: "f", input: { a: 1 } },
      ],
      stop_reason: "tool_use", // a functionCall part was present
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 4 },
    });
  });

  it("maps MAX_TOKENS → max_tokens and tolerates empty candidates", () => {
    expect(
      geminiToAnthropic(
        buf({ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "MAX_TOKENS" }] }),
        fallback,
      ).stop_reason,
    ).toBe("max_tokens");
    const empty = geminiToAnthropic(buf({ candidates: [] }), fallback);
    expect(empty.content).toEqual([{ type: "text", text: "" }]);
    expect(empty.model).toBe("fb");
  });
});
