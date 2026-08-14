/**
 * R6.1 case (b) — streaming translation: an OpenAI Chat Completions SSE stream →
 * an Anthropic Messages SSE stream, incrementally (spec Decision 22). Slice b2
 * did text; **b3** adds streaming tool-use.
 *
 *   OpenAI:   `data: {choices:[{delta:{content|tool_calls}, finish_reason}], usage?}` … `data: [DONE]`
 *   Anthropic: event: message_start / content_block_start /
 *              content_block_delta* / content_block_stop / message_delta / message_stop
 *
 * Anthropic content blocks are STRICTLY SEQUENTIAL (start i → deltas → stop i →
 * start i+1); OpenAI streams text first, then each tool call's `arguments` in
 * fragments. So this Transform keeps exactly one block open at a time and closes
 * it before opening the next. Text → a `text` block (`text_delta`); each OpenAI
 * tool-call index → a `tool_use` block (`input_json_delta` carrying the raw
 * `arguments` fragments). It NEVER runs on the Anthropic passthrough.
 */

import { Transform, type TransformCallback } from "node:stream";
import { mapStopReason, SYNTHESIZED_THINKING_LABEL } from "./openai-translate.js";

/** Anthropic `tool_use.id` pattern: `^[a-zA-Z0-9_-]+$`. */
const TOOL_ID_BAD = /[^a-zA-Z0-9_-]/g;

function sanitizeToolId(id: string): string {
  return id.replace(TOOL_ID_BAD, "_");
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** OpenAI streaming chunk (the fields we read; tolerant of the rest). */
interface OpenAIChunk {
  readonly id?: string;
  readonly model?: string;
  readonly choices?: ReadonlyArray<{
    readonly delta?: {
      readonly content?: string | null;
      // b4-kimi: reasoning models stream the thinking trace here.
      readonly reasoning_content?: string | null;
      readonly tool_calls?: ReadonlyArray<{
        readonly index: number;
        readonly id?: string;
        readonly function?: { readonly name?: string; readonly arguments?: string };
      }>;
    };
    readonly finish_reason?: string | null;
  }>;
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
}

/** The currently-open Anthropic content block. */
type Current = null | { kind: "thinking" } | { kind: "text" } | { kind: "tool"; oaiIndex: number };

/** Maximum SSE line length to buffer. Lines longer than this are truncated. */
const MAX_SSE_LINE_BYTES = 1_048_576; // 1 MB

/**
 * R10.16 — how often to emit a `ping` while the upstream is silent.
 *
 * Anthropic's own streams ping throughout; the OpenAI chat-completions schema
 * has no ping, so a translated stream used to send NOTHING for the whole
 * prefill — 124–152s of dead socket, measured on a 468k-token request. Well
 * inside both the proxy's `bodyTimeoutMs` (default 300_000) and any sane client
 * idle timeout, which is the point: the number exists to stay comfortably under
 * the smallest of them.
 */
const PING_INTERVAL_MS = 10_000;

export class OpenAIChatSSETranslator extends Transform {
  #buf = "";
  #started = false;
  #stopReason = "end_turn";
  #inputTokens = 0;
  #outputTokens = 0;
  #id: string;
  #model: string;
  readonly #mapReasoning: boolean;

  // Sequential-block bookkeeping.
  #current: Current = null;
  #currentIndex = -1;
  #blockCount = 0;
  readonly #toolMeta = new Map<number, { id: string; name: string }>();

  // R10.16 keepalive state.
  #ended = false;
  #heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(fallback: {
    readonly id: string;
    readonly model: string;
    readonly mapReasoning?: boolean;
    /**
     * Emit a `ping` every {@link PING_INTERVAL_MS} while the upstream is silent.
     * On by default; tests turn it off so a unit test never depends on a timer.
     */
    readonly heartbeat?: boolean;
  }) {
    super();
    this.#id = fallback.id;
    this.#model = fallback.model;
    this.#mapReasoning = fallback.mapReasoning !== false;
    if (fallback.heartbeat !== false) this.#startHeartbeat();
  }

  /**
   * Keep the stream alive during a long prefill. `unref` so a pending ping can
   * never hold the process open, and every push is guarded by {@link #ended}
   * because pushing after `end` throws.
   */
  #startHeartbeat(): void {
    const timer = setInterval(() => {
      if (this.#ended) return;
      // Deliberately does NOT call #ensureStarted. Emitting `message_start`
      // early would mean naming the model before the upstream has said which
      // one served the request, replacing its real id/model with the configured
      // fallback — a fidelity cost this stream is asserted on, and one a
      // keepalive should not charge. A ping keeps the socket alive on its own,
      // so `message_start` stays lazy and stays accurate. Consequence, accepted:
      // a ping can precede `message_start` on a slow prefill.
      this.push(sse("ping", { type: "ping" }));
    }, PING_INTERVAL_MS);
    timer.unref?.();
    this.#heartbeat = timer;
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== null) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.#buf += chunk.toString("utf8");
    // Cap the buffer at MAX_SSE_LINE_BYTES — if a line is longer than that,
    // discard the excess to avoid unbounded memory growth from a slow or
    // malicious upstream (R8.18). The line is already corrupted for our
    // purposes; dropping it is safer than accumulating.
    if (this.#buf.length > MAX_SSE_LINE_BYTES) {
      this.#buf = "";
    }
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
    // Stop the heartbeat BEFORE anything else here: a ping racing the terminal
    // events would push after `end`, which throws.
    this.#stopHeartbeat();
    this.#ended = true;
    const tail = this.#buf.trim();
    if (tail.length > 0) this.#handleLine(tail);
    this.#ensureStarted();
    if (this.#blockCount === 0) {
      // R10.18: the upstream produced nothing. On this path the status line and
      // `message_start` have already gone out, so an HTTP error is no longer
      // available — say it IN-BAND, in a block the user can actually read,
      // rather than closing a well-formed empty stream. An empty stream is what
      // made the R10.14 failure undiagnosable: indistinguishable from a model
      // choosing to say nothing, so Claude Code looped on it for a day.
      //
      // Golem-prefixed and attributed: the proxy must never appear to speak as
      // the model (Decision 25, and the local-answer rail's precedent).
      this.#switchTo({ kind: "text" });
      this.push(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: this.#currentIndex,
          delta: { type: "text_delta", text: this.#emptyCompletionNotice() },
        }),
      );
    } else if (this.#current === null) {
      this.#switchTo({ kind: "text" });
    }
    this.#closeCurrent();
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
    // R10.16: an SSE COMMENT (`: …`) is the standard idle keepalive, and
    // OpenRouter emits them during a long prefill. These used to be discarded
    // here along with everything that is not a `data:` line, so real liveness
    // from the upstream reached nobody. Forward it as an Anthropic `ping` —
    // relaying genuine liveness beats inventing it on a timer.
    if (line.startsWith(":")) {
      // Same reasoning as the heartbeat: relay liveness without forcing
      // `message_start` out before the upstream has named its model.
      this.push(sse("ping", { type: "ping" }));
      return;
    }
    if (line === "" || !line.startsWith("data:")) return;
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
    const delta = choice?.delta;

    // b4-kimi: the thinking trace streams first (a reasoning model thinks before
    // it answers) → a leading Anthropic `thinking` block. No signature is emitted
    // (synthesized, non-Anthropic origin; display-only).
    const reasoning = delta?.reasoning_content;
    if (this.#mapReasoning && typeof reasoning === "string" && reasoning.length > 0) {
      this.#switchTo({ kind: "thinking" });
      this.push(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: this.#currentIndex,
          delta: { type: "thinking_delta", thinking: reasoning },
        }),
      );
    }

    const text = delta?.content;
    if (typeof text === "string" && text.length > 0) {
      this.#switchTo({ kind: "text" });
      this.push(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: this.#currentIndex,
          delta: { type: "text_delta", text },
        }),
      );
    }

    for (const tc of delta?.tool_calls ?? []) {
      const oaiIndex = tc.index;
      const prev = this.#toolMeta.get(oaiIndex) ?? { id: this.#id, name: "" };
      const meta = {
        id: typeof tc.id === "string" && tc.id.length > 0 ? sanitizeToolId(tc.id) : prev.id,
        name:
          typeof tc.function?.name === "string" && tc.function.name.length > 0
            ? tc.function.name
            : prev.name,
      };
      this.#toolMeta.set(oaiIndex, meta);
      this.#switchTo({ kind: "tool", oaiIndex });
      const args = tc.function?.arguments;
      if (typeof args === "string" && args.length > 0) {
        this.push(
          sse("content_block_delta", {
            type: "content_block_delta",
            index: this.#currentIndex,
            delta: { type: "input_json_delta", partial_json: args },
          }),
        );
      }
    }

    if (choice?.finish_reason != null) this.#stopReason = mapStopReason(choice.finish_reason);
  }

  /**
   * The in-band text for an upstream that streamed no content at all (R10.18).
   * Names the model and, when it is the cause, the max_tokens case — a reader
   * has to be able to act on it.
   */
  #emptyCompletionNotice(): string {
    const base = `**Golem** The upstream model "${this.#model}" returned an empty completion — no text and no tool calls.`;
    return this.#stopReason === "max_tokens"
      ? `${base} It hit max_tokens before emitting any output; raise max_tokens or shorten the request.`
      : `${base} This is the upstream's response, not a reply from the model.`;
  }

  /** Emit message_start exactly once, lazily (using the id/model seen so far). */
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

  /** Ensure the requested block is the open one, closing any other first (sequential blocks). */
  #switchTo(
    target: { kind: "thinking" } | { kind: "text" } | { kind: "tool"; oaiIndex: number },
  ): void {
    this.#ensureStarted();
    if (this.#current !== null) {
      if (this.#current.kind === target.kind) {
        if (target.kind !== "tool") return; // thinking/text: a single block, already open
        if (
          this.#current.kind === "tool" &&
          this.#current.oaiIndex === (target as { oaiIndex: number }).oaiIndex
        ) {
          return;
        }
      }
      this.#closeCurrent();
    }
    this.#currentIndex = this.#blockCount++;
    if (target.kind === "thinking") {
      this.#current = { kind: "thinking" };
      this.push(
        sse("content_block_start", {
          type: "content_block_start",
          index: this.#currentIndex,
          content_block: { type: "thinking", thinking: "" },
        }),
      );
      // R10.20: label it before any trace fragment arrives. An unlabelled
      // synthesized block is indistinguishable from an Anthropic one, and a
      // model reciting its own context inside one reads as a data leak.
      this.push(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: this.#currentIndex,
          delta: { type: "thinking_delta", thinking: SYNTHESIZED_THINKING_LABEL },
        }),
      );
    } else if (target.kind === "text") {
      this.#current = { kind: "text" };
      this.push(
        sse("content_block_start", {
          type: "content_block_start",
          index: this.#currentIndex,
          content_block: { type: "text", text: "" },
        }),
      );
    } else {
      const meta = this.#toolMeta.get(target.oaiIndex) ?? { id: this.#id, name: "" };
      this.#current = { kind: "tool", oaiIndex: target.oaiIndex };
      this.push(
        sse("content_block_start", {
          type: "content_block_start",
          index: this.#currentIndex,
          content_block: { type: "tool_use", id: meta.id, name: meta.name, input: {} },
        }),
      );
    }
  }
}

/** Factory used by the proxy's translating seam. */
export function createOpenAIToAnthropicSSE(fallback: {
  readonly id: string;
  readonly model: string;
  readonly mapReasoning?: boolean;
  /** R10.16 keepalive; on by default. Tests disable it to stay timer-free. */
  readonly heartbeat?: boolean;
}): OpenAIChatSSETranslator {
  return new OpenAIChatSSETranslator(fallback);
}
