/**
 * R2.3 — eligibility check + Anthropic-response synthesis
 * (src/pipeline/local-answer-response.ts), unit-tested directly against the
 * recorded-shape conventions tests/integration/helpers/anthropic-fixtures.ts
 * documents (non-streaming JSON vs SSE event sequence).
 */

import { describe, expect, it } from "vitest";
import {
  eligibleLocalAnswerText,
  LOCAL_ANSWER_MODEL_ID,
  synthesizeLocalAnswerResponse,
} from "../../../src/pipeline/local-answer-response.js";

describe("eligibleLocalAnswerText", () => {
  it("accepts a single user message with bare string content", () => {
    const body = { messages: [{ role: "user", content: "how do I deploy this?" }] };
    expect(eligibleLocalAnswerText(body)).toBe("how do I deploy this?");
  });

  it("accepts a single user message with one text content block", () => {
    const body = {
      messages: [{ role: "user", content: [{ type: "text", text: "how do I deploy this?" }] }],
    };
    expect(eligibleLocalAnswerText(body)).toBe("how do I deploy this?");
  });

  it("rejects multi-turn conversations", () => {
    const body = {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "how do I deploy this?" },
      ],
    };
    expect(eligibleLocalAnswerText(body)).toBeUndefined();
  });

  it("rejects an assistant-authored single message", () => {
    const body = { messages: [{ role: "assistant", content: "hi" }] };
    expect(eligibleLocalAnswerText(body)).toBeUndefined();
  });

  it("rejects tool_result content", () => {
    const body = {
      messages: [{ role: "user", content: [{ type: "tool_result", content: "some output" }] }],
    };
    expect(eligibleLocalAnswerText(body)).toBeUndefined();
  });

  it("rejects multiple content blocks (e.g. text + image)", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } },
          ],
        },
      ],
    };
    expect(eligibleLocalAnswerText(body)).toBeUndefined();
  });

  it("rejects a missing messages array", () => {
    expect(eligibleLocalAnswerText({})).toBeUndefined();
  });

  it("rejects an empty messages array", () => {
    expect(eligibleLocalAnswerText({ messages: [] })).toBeUndefined();
  });
});

describe("synthesizeLocalAnswerResponse", () => {
  it("builds a non-streaming JSON response matching the Anthropic Messages shape", () => {
    const res = synthesizeLocalAnswerResponse("what is golem?", "Golem is a proxy.", false);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.headers["content-length"]).toBe(String(res.body.byteLength));

    const payload = JSON.parse(res.body.toString("utf8"));
    expect(payload.type).toBe("message");
    expect(payload.role).toBe("assistant");
    expect(payload.model).toBe(LOCAL_ANSWER_MODEL_ID);
    expect(payload.model).not.toMatch(/claude/i);
    expect(payload.content).toEqual([{ type: "text", text: "Golem is a proxy." }]);
    expect(payload.stop_reason).toBe("end_turn");
    expect(payload.stop_sequence).toBeNull();
    expect(payload.usage.input_tokens).toBeGreaterThan(0);
    expect(payload.usage.output_tokens).toBeGreaterThan(0);
    expect(payload.usage.cache_creation_input_tokens).toBe(0);
    expect(payload.usage.cache_read_input_tokens).toBe(0);
    expect(typeof payload.id).toBe("string");
    expect(payload.id).toMatch(/^msg_local_[0-9a-f]{32}$/);
  });

  it("mints a fresh message id per call", () => {
    const a = synthesizeLocalAnswerResponse("q", "a", false);
    const b = synthesizeLocalAnswerResponse("q", "a", false);
    const idOf = (r: typeof a) => JSON.parse(r.body.toString("utf8")).id as string;
    expect(idOf(a)).not.toBe(idOf(b));
  });

  it("builds a full SSE event sequence when streaming is requested", () => {
    const res = synthesizeLocalAnswerResponse("what is golem?", "Golem is a proxy.", true);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");

    const text = res.body.toString("utf8");
    const events = [...text.matchAll(/event: (\w+)\ndata: (.+)\n\n/g)].map((m) => ({
      event: m[1],
      data: JSON.parse(m[2] as string),
    }));
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    expect(events[0]?.data.message.model).toBe(LOCAL_ANSWER_MODEL_ID);
    expect(events[0]?.data.message.stop_reason).toBeNull();
    expect(events[1]?.data.content_block).toEqual({ type: "text", text: "" });
    expect(events[2]?.data.delta).toEqual({ type: "text_delta", text: "Golem is a proxy." });
    expect(events[3]?.data.index).toBe(0);
    expect(events[4]?.data.delta.stop_reason).toBe("end_turn");
    expect(events[4]?.data.usage.output_tokens).toBeGreaterThan(0);
  });

  it("respects the caller-provided stream flag independent of content", () => {
    const streaming = synthesizeLocalAnswerResponse("q", "an answer with lots of words here", true);
    expect(streaming.headers["content-type"]).toBe("text/event-stream");
    const nonStreaming = synthesizeLocalAnswerResponse(
      "q",
      "an answer with lots of words here",
      false,
    );
    expect(nonStreaming.headers["content-type"]).toBe("application/json");
  });
});
