/**
 * R6.1 case (b) slice b2 — streaming translation: an OpenAI Chat Completions
 * SSE stream → an Anthropic Messages SSE stream, incrementally (spec Decision 22).
 *
 * Claude Code almost always sends `stream: true`, so this is the slice that makes
 * an OpenAI-schema upstream (OpenAI / Ollama, local or LAN) actually usable in
 * the editor. The two event protocols differ:
 *
 *   OpenAI:   `data: {choices:[{delta:{content}, finish_reason}], usage?}` … `data: [DONE]`
 *   Anthropic: event: message_start / content_block_start /
 *              content_block_delta* / content_block_stop / message_delta / message_stop
 *
 * This `Transform` consumes OpenAI SSE bytes (chunked arbitrarily on any
 * boundary) and emits well-formed Anthropic SSE bytes. It is stateful but
 * self-contained and unit-tested by feeding chunk sequences. It NEVER runs on
 * the Anthropic passthrough — only when a translating upstream streams.
 *
 * b2 scope: a single text content block (index 0). Tool-use streaming is b3.
 */

import { Transform, type TransformCallback } from "node:stream";
import { mapStopReason } from "./openai-translate.js";

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** OpenAI streaming chunk (the fields we read; tolerant of the rest). */
interface OpenAIChunk {
  readonly id?: string;
  readonly model?: string;
  readonly choices?: ReadonlyArray<{
    readonly delta?: { readonly content?: string | null };
    readonly finish_reason?: string | null;
  }>;
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
}

export class OpenAIChatSSETranslator extends Transform {
  #buf = "";
  #started = false;
  #contentStarted = false;
  #stopReason = "end_turn";
  #inputTokens = 0;
  #outputTokens = 0;
  #id: string;
  #model: string;

  constructor(fallback: { readonly id: string; readonly model: string }) {
    super();
    this.#id = fallback.id;
    this.#model = fallback.model;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.#buf += chunk.toString("utf8");
    // SSE frames are newline-delimited; process complete lines, keep the tail.
    let nl = this.#buf.indexOf("\n");
    while (nl !== -1) {
      const line = this.#buf.slice(0, nl).trimEnd();
      this.#buf = this.#buf.slice(nl + 1);
      this.#handleLine(line);
      nl = this.#buf.indexOf("\n");
    }
    cb();
  }

  override _flush(cb: TransformCallback): void {
    // Process any trailing partial line, then close the Anthropic message.
    const tail = this.#buf.trim();
    if (tail.length > 0) this.#handleLine(tail);
    this.#ensureStarted();
    if (this.#contentStarted)
      this.push(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
    this.push(
      sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: this.#stopReason, stop_sequence: null },
        usage: { input_tokens: this.#inputTokens, output_tokens: this.#outputTokens },
      }),
    );
    this.push(sse("message_stop", { type: "message_stop" }));
    cb();
  }

  #handleLine(line: string): void {
    if (line === "" || !line.startsWith("data:")) return; // ignore comments/blank/`event:` lines
    const payload = line.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") return;
    let chunk: OpenAIChunk;
    try {
      chunk = JSON.parse(payload) as OpenAIChunk;
    } catch {
      return; // skip an unparseable frame rather than breaking the stream
    }
    if (typeof chunk.id === "string") this.#id = chunk.id;
    if (typeof chunk.model === "string") this.#model = chunk.model;
    if (chunk.usage !== undefined) {
      if (typeof chunk.usage.prompt_tokens === "number")
        this.#inputTokens = chunk.usage.prompt_tokens;
      if (typeof chunk.usage.completion_tokens === "number")
        this.#outputTokens = chunk.usage.completion_tokens;
    }
    const choice = chunk.choices?.[0];
    const text = choice?.delta?.content;
    if (typeof text === "string" && text.length > 0) {
      this.#ensureStarted();
      this.push(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        }),
      );
    }
    if (choice?.finish_reason != null) {
      this.#stopReason = mapStopReason(choice.finish_reason);
    }
  }

  /** Emit message_start + content_block_start exactly once, lazily. */
  #ensureStarted(): void {
    if (!this.#started) {
      this.#started = true;
      this.push(
        sse("message_start", {
          type: "message_start",
          message: {
            id: this.#id,
            type: "message",
            role: "assistant",
            model: this.#model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: this.#inputTokens, output_tokens: 0 },
          },
        }),
      );
    }
    if (!this.#contentStarted) {
      this.#contentStarted = true;
      this.push(
        sse("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      );
    }
  }
}

/** Factory used by the proxy's translating seam. */
export function createOpenAIToAnthropicSSE(fallback: {
  readonly id: string;
  readonly model: string;
}): OpenAIChatSSETranslator {
  return new OpenAIChatSSETranslator(fallback);
}
