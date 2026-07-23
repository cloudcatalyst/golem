/**
 * R6.1 case (b) slice b4-gemini — streaming translation: Gemini
 * streamGenerateContent SSE → Anthropic Messages SSE.
 */

import { describe, expect, it } from "vitest";
import { createGeminiToAnthropicSSE } from "../../../src/providers/index.js";

async function run(chunks: string[]): Promise<string> {
  const t = createGeminiToAnthropicSSE({ id: "msg_fb", model: "fb" });
  const out: Buffer[] = [];
  t.on("data", (c: Buffer) => out.push(Buffer.from(c)));
  const done = new Promise<void>((resolve) => t.on("end", () => resolve()));
  for (const c of chunks) t.write(Buffer.from(c, "utf8"));
  t.end();
  await done;
  return Buffer.concat(out).toString("utf8");
}

const events = (sse: string) => [...sse.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
function firstData(sse: string, event: string): Record<string, unknown> {
  const m = sse.match(new RegExp(`event: ${event}\\ndata: (.+)`));
  if (m?.[1] === undefined) throw new Error(`no ${event}`);
  return JSON.parse(m[1]);
}

describe("Gemini → Anthropic SSE translation", () => {
  it("streams text then a whole functionCall as separate blocks", async () => {
    const sse = await run([
      'data: {"responseId":"r1","modelVersion":"gemini-2.0-flash","candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"f","args":{"a":1}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":4}}\n\n',
    ]);
    expect(events(sse)).toEqual([
      "message_start",
      "content_block_start", // text, index 0
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start", // tool_use, index 1
      "content_block_delta", // input_json_delta (whole args)
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(firstData(sse, "message_start").message).toMatchObject({
      id: "r1",
      model: "gemini-2.0-flash",
    });
    const texts = [...sse.matchAll(/"text_delta","text":"([^"]*)"/g)].map((m) => m[1]);
    expect(texts.join("")).toBe("Hello");
    const starts = [...sse.matchAll(/event: content_block_start\ndata: (.+)/g)].map((m) =>
      JSON.parse(m[1] as string),
    );
    expect(starts[1]).toMatchObject({
      index: 1,
      content_block: { type: "tool_use", id: "call_0", name: "f" },
    });
    const partial = sse.match(/"input_json_delta","partial_json":"((?:[^"\\]|\\.)*)"/);
    expect(JSON.parse(`"${partial?.[1]}"`)).toBe('{"a":1}');
    const md = firstData(sse, "message_delta");
    expect(md.delta).toMatchObject({ stop_reason: "tool_use" });
    expect(md.usage).toEqual({ input_tokens: 10, output_tokens: 4 });
  });

  it("emits a valid empty message when the stream carries nothing", async () => {
    const sse = await run(["\n"]);
    expect(events(sse)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });
});
