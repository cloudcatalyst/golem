/**
 * R6.1 case (b) slice b2 — streaming translation: OpenAI Chat Completions SSE →
 * Anthropic Messages SSE, incrementally.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createOpenAIToAnthropicSSE,
  SYNTHESIZED_THINKING_LABEL,
} from "../../../src/providers/index.js";

/** Feed the given raw chunks through the translator and collect the output text. */
async function run(chunks: string[], mapReasoning?: boolean): Promise<string> {
  const t = createOpenAIToAnthropicSSE({
    id: "msg_fb",
    model: "fb-model",
    // R10.16: no wall-clock in a unit test. The heartbeat has its own test.
    heartbeat: false,
    ...(mapReasoning !== undefined ? { mapReasoning } : {}),
  });
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

  it("emits a well-formed message when the stream carries no content", async () => {
    const sse = await run(["data: [DONE]\n\n"]);
    // R10.18: the block is no longer EMPTY — it carries a notice saying the
    // upstream produced nothing (asserted in the "empty stream" block below).
    // The event sequence must still be a valid Anthropic stream.
    expect(events(sse)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
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

  it("maps streamed reasoning_content to a leading thinking block (b4-kimi)", async () => {
    const sse = await run([
      'data: {"id":"c1","model":"kimi-k3","choices":[{"delta":{"reasoning_content":"let me "}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(events(sse)).toEqual([
      "message_start",
      "content_block_start", // thinking, index 0
      "content_block_delta", // R10.20 label — the block is Golem's reconstruction
      "content_block_delta", // thinking_delta "let me "
      "content_block_delta", // thinking_delta "think"
      "content_block_stop", // close thinking before opening text
      "content_block_start", // text, index 1
      "content_block_delta", // text_delta "answer"
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const starts = [...sse.matchAll(/event: content_block_start\ndata: (.+)/g)].map((m) =>
      JSON.parse(m[1] as string),
    );
    expect(starts[0]).toMatchObject({ index: 0, content_block: { type: "thinking" } });
    expect(starts[1]).toMatchObject({ index: 1, content_block: { type: "text" } });
    const thinking = [...sse.matchAll(/"thinking_delta","thinking":"((?:[^"\\]|\\.)*)"/g)].map(
      (m) => JSON.parse(`"${m[1]}"`),
    );
    // R10.20: the trace is relayed verbatim, behind a label naming it as Golem's.
    expect(thinking.join("")).toBe(`${SYNTHESIZED_THINKING_LABEL}let me think`);
  });

  it("suppresses thinking blocks when mapReasoning is false", async () => {
    const sse = await run(
      [
        'data: {"choices":[{"delta":{"reasoning_content":"hidden"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
        "data: [DONE]\n\n",
      ],
      false,
    );
    expect(sse).not.toContain("thinking");
    const texts = [...sse.matchAll(/"text_delta","text":"([^"]*)"/g)].map((m) => m[1]);
    expect(texts.join("")).toBe("answer");
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

/**
 * R10.18 — a stream that produced nothing. Headers and `message_start` are
 * already out by `_flush`, so an HTTP status is no longer available: say it
 * in-band, in a block the user can read. A well-formed EMPTY stream is what made
 * the R10.14 failure undiagnosable.
 */
describe("empty stream (R10.18)", () => {
  it("emits a readable, Golem-attributed notice instead of an empty text block", async () => {
    const sse = await run(["data: [DONE]\n\n"]);
    expect(events(sse)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const deltas = [...sse.matchAll(/event: content_block_delta\ndata: (.+)/g)].map((m) =>
      JSON.parse(m[1] as string),
    );
    const text = deltas.map((d) => d.delta.text).join("");
    // Attributed to Golem — the proxy must never appear to speak as the model.
    expect(text).toContain("**Golem**");
    expect(text).toContain("empty completion");
  });

  it("names the max_tokens case when that is why nothing came back", async () => {
    const sse = await run([
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const text = [...sse.matchAll(/event: content_block_delta\ndata: (.+)/g)]
      .map((m) => JSON.parse(m[1] as string).delta.text)
      .join("");
    expect(text).toContain("max_tokens");
  });

  it("leaves a stream that DID produce content untouched", async () => {
    const sse = await run([
      'data: {"choices":[{"delta":{"content":"real answer"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const text = [...sse.matchAll(/event: content_block_delta\ndata: (.+)/g)]
      .map((m) => JSON.parse(m[1] as string).delta.text)
      .join("");
    expect(text).toBe("real answer");
    expect(text).not.toContain("**Golem**");
  });

  it("does not fire for a tool-only stream", async () => {
    const sse = await run([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"f","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(sse).not.toContain("**Golem**");
  });
});

/**
 * R10.16 — keepalive. A translated stream used to send NOTHING for the whole
 * prefill: 124–152s of dead socket, measured on a real 468k-token request.
 * Anthropic's own streams ping throughout; the OpenAI schema has no ping.
 */
describe("keepalive (R10.16)", () => {
  it("forwards an upstream SSE comment as a ping instead of discarding it", async () => {
    // OpenRouter emits `: OPENROUTER PROCESSING` during a long prefill. These
    // were dropped by the `data:`-only guard, so real liveness reached nobody.
    const sse = await run([
      ": OPENROUTER PROCESSING\n\n",
      ": OPENROUTER PROCESSING\n\n",
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(events(sse).filter((e) => e === "ping")).toHaveLength(2);
    // Relaying liveness must not disturb the content stream.
    const deltas = [...sse.matchAll(/"text_delta","text":"([^"]*)"/g)].map((m) => m[1]);
    expect(deltas).toEqual(["hi"]);
  });

  it("does not let a comment force message_start out early", async () => {
    // Emitting message_start on a ping would name the model before the upstream
    // said which one served the request, replacing its real id/model with the
    // configured fallback. The ping keeps the socket alive on its own.
    const sse = await run([
      ": keepalive\n\n",
      'data: {"id":"c1","model":"real-model","choices":[{"delta":{"content":"x"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(events(sse)[0]).toBe("ping");
    expect(firstData(sse, "message_start").message).toMatchObject({
      id: "c1",
      model: "real-model",
    });
  });

  it("emits a ping while the upstream is silent, and stops at end", async () => {
    const t = createOpenAIToAnthropicSSE({ id: "msg_fb", model: "fb-model" });
    const out: Buffer[] = [];
    t.on("data", (c: Buffer) => out.push(Buffer.from(c)));
    const done = new Promise<void>((resolve) => t.on("end", () => resolve()));

    // Drive the heartbeat without waiting on wall-clock: fire the interval the
    // constructor registered.
    vi.useFakeTimers();
    const t2 = createOpenAIToAnthropicSSE({ id: "msg_fb2", model: "fb-model" });
    const out2: Buffer[] = [];
    t2.on("data", (c: Buffer) => out2.push(Buffer.from(c)));
    vi.advanceTimersByTime(25_000);
    const pings =
      Buffer.concat(out2)
        .toString("utf8")
        .match(/event: ping/g) ?? [];
    expect(pings.length).toBeGreaterThanOrEqual(2);
    t2.end();
    vi.useRealTimers();

    // The un-advanced stream saw no ping, and ending it is clean.
    t.write(Buffer.from('data: {"choices":[{"delta":{"content":"x"}}]}\n\n', "utf8"));
    t.end();
    await done;
    expect(Buffer.concat(out).toString("utf8")).not.toContain("event: ping");
  });
});
