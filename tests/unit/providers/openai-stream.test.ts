/**
 * R6.1 case (b) slice b2 — streaming translation: OpenAI Chat Completions SSE →
 * Anthropic Messages SSE, incrementally.
 */

import { describe, expect, it } from "vitest";
import { createOpenAIToAnthropicSSE } from "../../../src/providers/index.js";

/** Feed the given raw chunks through the translator and collect the output text. */
async function run(chunks: string[]): Promise<string> {
  const t = createOpenAIToAnthropicSSE({ id: "msg_fb", model: "fb-model" });
  const out: Buffer[] = [];
  t.on("data", (c: Buffer) => out.push(Buffer.from(c)));
  const done = new Promise<void>((resolve) => t.on("end", () => resolve()));
  for (const c of chunks) t.write(Buffer.from(c, "utf8"));
  t.end();
  await done;
  return Buffer.concat(out).toString("utf8");
}

/** Event type names in emission order. */
function events(sse: string): string[] {
  return [...sse.matchAll(/^event: (.+)$/gm)].map((m) => m[1] as string);
}

/** Parse the `data:` JSON of the first frame whose `event:` matches. */
function firstData(sse: string, event: string): Record<string, unknown> {
  const re = new RegExp(`event: ${event}\\ndata: (.+)`);
  const m = sse.match(re);
  if (m?.[1] === undefined) throw new Error(`no ${event} frame`);
  return JSON.parse(m[1]);
}

const HAPPY = [
  'data: {"id":"c1","model":"qwen2.5-coder:7b","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
  "data: [DONE]\n\n",
];

describe("OpenAI → Anthropic SSE translation", () => {
  it("emits the Anthropic event sequence with concatenated text, stop_reason and usage", async () => {
    const sse = await run(HAPPY);
    expect(events(sse)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    // Uses the upstream's id/model from the chunks.
    expect(firstData(sse, "message_start").message).toMatchObject({
      id: "c1",
      role: "assistant",
      model: "qwen2.5-coder:7b",
    });

    // Text deltas carry the streamed pieces.
    const deltas = [...sse.matchAll(/"text_delta","text":"([^"]*)"/g)].map((m) => m[1]);
    expect(deltas).toEqual(["Hel", "lo"]);

    const md = firstData(sse, "message_delta");
    expect(md.delta).toEqual({ stop_reason: "end_turn", stop_sequence: null });
    expect(md.usage).toEqual({ input_tokens: 10, output_tokens: 2 });
  });

  it("is robust to chunk boundaries that split SSE frames mid-line", async () => {
    const whole = HAPPY.join("");
    // Split into arbitrary byte-ish thirds.
    const a = whole.slice(0, 40);
    const b = whole.slice(40, 130);
    const c = whole.slice(130);
    const sse = await run([a, b, c]);
    expect(events(sse)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const deltas = [...sse.matchAll(/"text_delta","text":"([^"]*)"/g)].map((m) => m[1]);
    expect(deltas).toEqual(["Hel", "lo"]);
  });

  it("maps finish_reason length → max_tokens", async () => {
    const sse = await run([
      'data: {"choices":[{"delta":{"content":"x"},"finish_reason":"length"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(firstData(sse, "message_delta").delta).toMatchObject({ stop_reason: "max_tokens" });
  });

  it("emits a valid empty message when the stream carries no content", async () => {
    const sse = await run(["data: [DONE]\n\n"]);
    expect(events(sse)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    // Falls back to the provided id/model when the stream never announced them.
    expect(firstData(sse, "message_start").message).toMatchObject({
      id: "msg_fb",
      model: "fb-model",
    });
  });

  it("streams a tool call: content_block_start(tool_use) + input_json_delta fragments (b3)", async () => {
    const sse = await run([
      'data: {"id":"c1","model":"m","choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"ci"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"SF\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(events(sse)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    // The tool_use block carries id + name; index 0 (no text preceded it).
    expect(firstData(sse, "content_block_start")).toMatchObject({
      index: 0,
      content_block: { type: "tool_use", id: "call_1", name: "get_weather", input: {} },
    });
    // input_json_delta fragments concatenate to the full arguments JSON.
    const partials = [
      ...sse.matchAll(/"input_json_delta","partial_json":"((?:[^"\\]|\\.)*)"/g),
    ].map((m) => JSON.parse(`"${m[1]}"`));
    expect(partials.join("")).toBe('{"city":"SF"}');
    expect(firstData(sse, "message_delta").delta).toMatchObject({ stop_reason: "tool_use" });
  });

  it("sequences text then a tool call as separate blocks (indices 0 then 1)", async () => {
    const sse = await run([
      'data: {"choices":[{"delta":{"content":"ok "}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c9","function":{"name":"f","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(events(sse)).toEqual([
      "message_start",
      "content_block_start", // text, index 0
      "content_block_delta", // text_delta "ok "
      "content_block_stop", // close text block before opening the tool block
      "content_block_start", // tool_use, index 1
      "content_block_delta", // input_json_delta "{}"
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const starts = [...sse.matchAll(/event: content_block_start\ndata: (.+)/g)].map((m) =>
      JSON.parse(m[1] as string),
    );
    expect(starts[0]).toMatchObject({ index: 0, content_block: { type: "text" } });
    expect(starts[1]).toMatchObject({ index: 1, content_block: { type: "tool_use", name: "f" } });
  });
});
