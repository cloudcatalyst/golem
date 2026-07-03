/**
 * Recorded Anthropic Messages API response shapes (verification-notes §15,
 * checked against live streaming docs 2026-07-03).
 *
 * Fixtures are constructed with explicit "\n" escapes rather than committed
 * as raw text files so git line-ending normalization can never alter the
 * bytes the fidelity assertions compare against.
 */

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Non-streaming response with text + tool_use blocks and cache usage. */
export const NON_STREAMING_TOOL_USE_RESPONSE: string = JSON.stringify({
  id: "msg_01XFDUDYJgAACzvnptvVoYEL",
  type: "message",
  role: "assistant",
  model: "claude-opus-4-8",
  content: [
    { type: "text", text: "I'll check the weather in Paris — un instant ☀️." },
    {
      type: "tool_use",
      id: "toolu_01T1x1fJ34qAmk2tNTrN7Up6",
      name: "get_weather",
      input: { location: "Paris, France", unit: "celsius" },
    },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: {
    input_tokens: 2095,
    cache_creation_input_tokens: 1024,
    cache_read_input_tokens: 1024,
    output_tokens: 89,
  },
});

/**
 * Kitchen-sink SSE stream covering every event class the proxy must pass
 * byte-faithful: message_start, ping, thinking_delta + signature_delta,
 * text_delta (multibyte UTF-8), tool_use with partial input_json_delta
 * fragments, server_tool_use, web_search_tool_result (encrypted server
 * content), tool_reference (tool search behind a gateway, notes §12),
 * message_delta, message_stop.
 */
export const SSE_STREAM_FIXTURE: string = [
  sse("message_start", {
    type: "message_start",
    message: {
      id: "msg_014p7gG3wDgGV9EUtLvnow3U",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 472,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 448,
        output_tokens: 2,
      },
    },
  }),
  sse("ping", { type: "ping" }),
  sse("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "" },
  }),
  sse("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: {
      type: "thinking_delta",
      thinking: "The user wants weather; I should call get_weather.",
    },
  }),
  sse("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: {
      type: "signature_delta",
      signature: "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds+XWMreDGf5JyU5UT",
    },
  }),
  sse("content_block_stop", { type: "content_block_stop", index: 0 }),
  sse("content_block_start", {
    type: "content_block_start",
    index: 1,
    content_block: { type: "text", text: "" },
  }),
  sse("content_block_delta", {
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: "Voici la météo — " },
  }),
  sse("content_block_delta", {
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: "天気 ☀️ 🌦️." },
  }),
  sse("content_block_stop", { type: "content_block_stop", index: 1 }),
  sse("content_block_start", {
    type: "content_block_start",
    index: 2,
    content_block: {
      type: "tool_use",
      id: "toolu_01T1x1fJ34qAmk2tNTrN7Up6",
      name: "get_weather",
      input: {},
    },
  }),
  // Partial JSON fragments: individually unparseable — the proxy must never
  // attempt to reassemble or re-serialize them.
  sse("content_block_delta", {
    type: "content_block_delta",
    index: 2,
    delta: { type: "input_json_delta", partial_json: '{"loc' },
  }),
  sse("content_block_delta", {
    type: "content_block_delta",
    index: 2,
    delta: { type: "input_json_delta", partial_json: 'ation": "Par' },
  }),
  sse("content_block_delta", {
    type: "content_block_delta",
    index: 2,
    delta: { type: "input_json_delta", partial_json: 'is, France", "unit": "celsius"}' },
  }),
  sse("content_block_stop", { type: "content_block_stop", index: 2 }),
  sse("content_block_start", {
    type: "content_block_start",
    index: 3,
    content_block: {
      type: "server_tool_use",
      id: "srvtoolu_014hJH82Qum7Td6UV8gDXThB",
      name: "web_search",
      input: {},
    },
  }),
  sse("content_block_delta", {
    type: "content_block_delta",
    index: 3,
    delta: { type: "input_json_delta", partial_json: '{"query": "paris weather today"}' },
  }),
  sse("content_block_stop", { type: "content_block_stop", index: 3 }),
  sse("content_block_start", {
    type: "content_block_start",
    index: 4,
    content_block: {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_014hJH82Qum7Td6UV8gDXThB",
      content: [
        {
          type: "web_search_result",
          title: "Weather in Paris",
          url: "https://example.com/paris-weather",
          encrypted_content: "EqgfCioIARgBIiQ3YTAwMjY1Mi1mZjM5LTQ1NGUtODgxNC1kNjNjNTk1ZWI3Y2Ey",
          page_age: "July 2, 2026",
        },
      ],
    },
  }),
  sse("content_block_stop", { type: "content_block_stop", index: 4 }),
  sse("content_block_start", {
    type: "content_block_start",
    index: 5,
    content_block: { type: "tool_reference", tool_name: "get_time" },
  }),
  sse("content_block_stop", { type: "content_block_stop", index: 5 }),
  sse("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 189 },
  }),
  sse("message_stop", { type: "message_stop" }),
].join("");

/** Stream that dies mid-generation with an SSE `error` event. */
export const SSE_ERROR_STREAM_FIXTURE: string = [
  sse("message_start", {
    type: "message_start",
    message: {
      id: "msg_01ErrStream00000000000000",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 1 },
    },
  }),
  sse("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }),
  sse("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Once upon a" },
  }),
  sse("error", {
    type: "error",
    error: { type: "overloaded_error", message: "Overloaded" },
  }),
].join("");

/**
 * Split a buffer into chunks of the given (cycled) sizes. Sizes are chosen
 * by callers to land mid-line, mid-JSON-escape and mid-UTF-8-codepoint so a
 * buffering/re-framing proxy would be caught.
 */
export function chunkify(buf: Buffer, sizes: readonly number[]): Buffer[] {
  const chunks: Buffer[] = [];
  let offset = 0;
  let i = 0;
  while (offset < buf.length) {
    const size = sizes[i % sizes.length] ?? 1;
    chunks.push(buf.subarray(offset, Math.min(offset + size, buf.length)));
    offset += size;
    i += 1;
  }
  return chunks;
}
