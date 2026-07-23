/**
 * R6.1 case (b) slice b4-gemini — streaming translation: a Gemini
 * `streamGenerateContent` SSE stream (`alt=sse`) → an Anthropic Messages SSE
 * stream (spec Decision 22; API verified verification-notes §77).
 *
 * Each Gemini SSE event's `data:` is a full `GenerateContentResponse` chunk with
 * `candidates[0].content.parts` — incremental `text`, and whole `functionCall`
 * parts (Gemini does not fragment tool-call args the way OpenAI does). This
 * mirrors the OpenAI streaming translator's sequential-block state machine
 * (openai-stream.ts) — Anthropic content blocks are strictly sequential, so at
 * most one is open at a time. (The block machinery is duplicated rather than
 * shared to keep the byte-faithful-adjacent OpenAI translator untouched; a
 * future refactor could extract a common base.)
 */

import { Transform, type TransformCallback } from "node:stream";
import { mapGeminiFinish } from "./gemini-translate.js";

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface GeminiChunk {
  readonly modelVersion?: string;
  readonly responseId?: string;
  readonly candidates?: ReadonlyArray<{
    readonly content?: {
      readonly parts?: ReadonlyArray<{
        readonly text?: string;
        readonly functionCall?: { readonly name?: string; readonly args?: Record<string, unknown> };
      }>;
    };
    readonly finishReason?: string | null;
  }>;
  readonly usageMetadata?: {
    readonly promptTokenCount?: number;
    readonly candidatesTokenCount?: number;
  };
}

type Current = null | { kind: "text" } | { kind: "tool" };

export class GeminiSSETranslator extends Transform {
  #buf = "";
  #started = false;
  #stopReason = "end_turn";
  #sawTool = false;
  #inputTokens = 0;
  #outputTokens = 0;
  #id: string;
  #model: string;
  #current: Current = null;
  #currentIndex = -1;
  #blockCount = 0;
  #toolSeq = 0;

  constructor(fallback: { readonly id: string; readonly model: string }) {
    super();
    this.#id = fallback.id;
    this.#model = fallback.model;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.#buf += chunk.toString("utf8");
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
    const tail = this.#buf.trim();
    if (tail.length > 0) this.#handleLine(tail);
    this.#ensureStarted();
    if (this.#current === null) this.#switchTo("text"); // valid empty text block
    this.#closeCurrent();
    this.push(
      sse("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: this.#sawTool ? "tool_use" : this.#stopReason,
          stop_sequence: null,
        },
        usage: { input_tokens: this.#inputTokens, output_tokens: this.#outputTokens },
      }),
    );
    this.push(sse("message_stop", { type: "message_stop" }));
    cb();
  }

  #handleLine(line: string): void {
    if (line === "" || !line.startsWith("data:")) return;
    const payload = line.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") return;
    let chunk: GeminiChunk;
    try {
      chunk = JSON.parse(payload) as GeminiChunk;
    } catch {
      return;
    }
    if (typeof chunk.responseId === "string") this.#id = chunk.responseId;
    if (typeof chunk.modelVersion === "string") this.#model = chunk.modelVersion;
    if (chunk.usageMetadata !== undefined) {
      if (typeof chunk.usageMetadata.promptTokenCount === "number")
        this.#inputTokens = chunk.usageMetadata.promptTokenCount;
      if (typeof chunk.usageMetadata.candidatesTokenCount === "number")
        this.#outputTokens = chunk.usageMetadata.candidatesTokenCount;
    }
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (typeof part.text === "string" && part.text.length > 0) {
        this.#switchTo("text");
        this.push(
          sse("content_block_delta", {
            type: "content_block_delta",
            index: this.#currentIndex,
            delta: { type: "text_delta", text: part.text },
          }),
        );
      } else if (part.functionCall !== undefined) {
        // Gemini sends a whole functionCall in one part → open a tool_use block,
        // emit its args as a single input_json_delta, close on the next switch.
        this.#sawTool = true;
        this.#openToolBlock(part.functionCall.name ?? "");
        this.push(
          sse("content_block_delta", {
            type: "content_block_delta",
            index: this.#currentIndex,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(part.functionCall.args ?? {}),
            },
          }),
        );
      }
    }
    if (candidate?.finishReason != null) this.#stopReason = mapGeminiFinish(candidate.finishReason);
  }

  #ensureStarted(): void {
    if (this.#started) return;
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

  #closeCurrent(): void {
    if (this.#current === null) return;
    this.push(sse("content_block_stop", { type: "content_block_stop", index: this.#currentIndex }));
    this.#current = null;
  }

  #switchTo(kind: "text"): void {
    this.#ensureStarted();
    if (this.#current?.kind === kind) return;
    this.#closeCurrent();
    this.#currentIndex = this.#blockCount++;
    this.#current = { kind: "text" };
    this.push(
      sse("content_block_start", {
        type: "content_block_start",
        index: this.#currentIndex,
        content_block: { type: "text", text: "" },
      }),
    );
  }

  /** Each functionCall opens a NEW tool_use block (Gemini sends them whole). */
  #openToolBlock(name: string): void {
    this.#ensureStarted();
    this.#closeCurrent();
    this.#currentIndex = this.#blockCount++;
    this.#current = { kind: "tool" };
    this.push(
      sse("content_block_start", {
        type: "content_block_start",
        index: this.#currentIndex,
        content_block: { type: "tool_use", id: `call_${this.#toolSeq++}`, name, input: {} },
      }),
    );
  }
}

export function createGeminiToAnthropicSSE(fallback: {
  readonly id: string;
  readonly model: string;
}): GeminiSSETranslator {
  return new GeminiSSETranslator(fallback);
}
