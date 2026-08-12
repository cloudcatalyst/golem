/**
 * R2.3 (spec Decision 24 sub-mode 2 / Decision 33) — eligibility check +
 * Anthropic-response synthesis for the local-answer sub-mode.
 *
 * Kept separate from `interfaces/local-answer.ts` (the frozen retrieval
 * contract): this module is proxy/pipeline glue — deciding WHETHER a parsed
 * request qualifies to be attempted at all, and how to shape a served answer
 * into bytes the Anthropic Messages API client already knows how to parse.
 * Shapes follow `tests/integration/helpers/anthropic-fixtures.ts` /
 * verification-notes §15 conventions.
 */

import { randomUUID } from "node:crypto";
import { estimateTokens } from "../compression/index.js";
import { isRecord } from "../shared/json.js";

/** Synthetic model id — never impersonates a real Claude model name. */
export const LOCAL_ANSWER_MODEL_ID = "golem-local-answer";

function extractPlainText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content.length === 1) {
    const block: unknown = content[0];
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return undefined;
}

/**
 * Longest a single-turn user message may be to still count as a standalone
 * retrieval question. A genuine "answer this from the project KB" question is a
 * sentence or two; a request whose user message EMBEDS its own large context —
 * a page to summarize, a file to explain, a document pasted for the model to
 * work against — is not a KB lookup and must reach the model with that context
 * intact.
 *
 * This gate exists because local-answer does KB retrieval on the query TEXT and
 * ignores any context embedded alongside it, so firing on a
 * document-carrying request substitutes generic KB content for the caller's
 * actual input. Observed in the wild: WebFetch's internal summarization model
 * call (a single-turn request carrying a fetched page) matched the project's
 * own README above the confidence floor and was served that instead of a
 * summary of the page. Length is a robust proxy for "this message carries its
 * own content"; declining is always safe — it just forwards to the upstream
 * model. ~1000 chars comfortably clears any real question while excluding
 * embedded documents (kilobytes).
 */
export const MAX_LOCAL_ANSWER_QUERY_CHARS = 1000;

/**
 * A parsed request body qualifies for the local-answer attempt only when it
 * is a single-turn, tool-free, plain-text user question: `messages.length
 * === 1`, role `user`, content is a bare string or a single `text` block,
 * the request defines NO tools, and the text is a short standalone question
 * (≤ {@link MAX_LOCAL_ANSWER_QUERY_CHARS}). Anything else (prior turns to
 * escalate mid-flow, tool_result content, multiple content blocks, images, or
 * a message that embeds its own large context) returns undefined — the caller
 * must fall through to the normal upstream path. This is the narrowing that
 * keeps this sub-mode's trigger tighter than Decision 25's general auto-draft.
 *
 * The tools check is load-bearing, not cosmetic: a request that DEFINES
 * `tools` (a `claude -p` one-shot in a wired project does) expects the model
 * may answer with `tool_use`; a locally-synthesized `end_turn` reply would
 * silently deny that capability. A present-but-non-array `tools` value fails
 * closed (ineligible); an explicitly empty array is fine.
 */
export function eligibleLocalAnswerText(
  body: Readonly<Record<string, unknown>>,
): string | undefined {
  const tools = body.tools;
  if (tools !== undefined && (!Array.isArray(tools) || tools.length > 0)) return undefined;
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length !== 1) return undefined;
  const message: unknown = messages[0];
  if (!isRecord(message) || message.role !== "user") return undefined;
  const text = extractPlainText(message.content);
  if (text === undefined || text.length > MAX_LOCAL_ANSWER_QUERY_CHARS) return undefined;
  return text;
}

export interface SynthesizedResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Build a byte-for-byte Anthropic Messages API response carrying `answerText`
 * — non-streaming JSON or an SSE stream, matching whichever the client
 * requested. `model` is always the real local identifier (never a Claude
 * model name); `stop_reason` is always `end_turn` (extractive answers never
 * request tool use).
 */
export function synthesizeLocalAnswerResponse(
  requestText: string,
  answerText: string,
  stream: boolean,
): SynthesizedResponse {
  const inputTokens = estimateTokens(requestText);
  const outputTokens = estimateTokens(answerText);
  const messageId = `msg_local_${randomUUID().replaceAll("-", "")}`;

  if (!stream) {
    const payload = {
      id: messageId,
      type: "message",
      role: "assistant",
      model: LOCAL_ANSWER_MODEL_ID,
      content: [{ type: "text", text: answerText }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: outputTokens,
      },
    };
    const json = JSON.stringify(payload);
    return {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(json)),
      },
      body: Buffer.from(json, "utf8"),
    };
  }

  const body = [
    sse("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: LOCAL_ANSWER_MODEL_ID,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        },
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
      delta: { type: "text_delta", text: answerText },
    }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: outputTokens },
    }),
    sse("message_stop", { type: "message_stop" }),
  ].join("");

  return {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    body: Buffer.from(body, "utf8"),
  };
}
