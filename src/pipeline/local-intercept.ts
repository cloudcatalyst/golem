/**
 * Decision 25 (spec v1.8) — proxy-side local-drafter intercept: "draft" and
 * "local_first" modes. Realizes spec §3.3 Draft/Critic using `delegate`'s
 * engine (`InferenceService`) with the proxy as the policy trigger.
 *
 * - Mode A "draft" (level >= 4, `stages.localDrafts`): runs a local model on
 *   the outgoing request and appends its answer as a labeled, clearly-marked
 *   block in `system`. Claude still receives and answers every request — this
 *   never changes what gets forwarded's outcome, only adds context.
 * - Mode B "local_first" (level 5 + opt-in, `stages.localOnlyAnswers`): tries
 *   to answer the request locally and skip Claude entirely. Escalates to
 *   Claude (via Mode A's injection mechanism, so the local compute is not
 *   wasted) whenever the call errors/times out, the request itself declares
 *   `tools`, or the draft text reads as a refusal/uncertainty ("I don't have
 *   access", "I can't see the file", ...) — `InferenceService.chat()` is
 *   text-only by frozen contract, so it structurally cannot serve any turn
 *   that needs Read/Edit/Bash. The `tools` check matters even when the draft
 *   text itself sounds confident: given a tool-bearing request the drafter
 *   can only narrate an action in plain text ("Let me read the file: ..."),
 *   never actually invoke it, and serving that as a final `end_turn` message
 *   silently drops the tool call — which is exactly what broke agentic
 *   subagent turns under Decision 26's local-first opt-in before this check
 *   was added.
 *
 * Both modes fail open: any inference error just skips the stage, exactly
 * like the semantic-compression stage's fail-open contract.
 */

import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatResult, InferenceService } from "../interfaces/inference.js";
import type { LocalResponse } from "../proxy/types.js";

/** Budget for one local-drafter call; a slow/hung local model must never stall the request. */
export const LOCAL_INTERCEPT_TIMEOUT_MS = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract plain text from an Anthropic `content` value: a string, or an array of content blocks. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!isRecord(block)) return "";
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "tool_result") return extractText(block.content);
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * Flatten an Anthropic-shaped `messages` array (+ optional `system`) into the
 * plain `{role, content: string}` pairs `InferenceService.chat()` expects.
 * Non-text blocks (tool_use, image, thinking, ...) are dropped — the local
 * model only ever sees the readable text of the conversation.
 */
export function toLocalChatMessages(messages: unknown, system?: unknown): ChatMessage[] {
  const out: ChatMessage[] = [];
  const systemText = extractText(system);
  if (systemText.length > 0) {
    out.push({ role: "system", content: systemText });
  }
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isRecord(message)) continue;
      const text = extractText(message.content);
      if (text.length === 0) continue;
      out.push({ role: typeof message.role === "string" ? message.role : "user", content: text });
    }
  }
  return out;
}

const REFUSAL_RE =
  /\b(i don't have access|i do not have access|i can'?t (?:see|read|access|view)|i need to see the file|as an ai\b|i'm not able to|i am not able to|i cannot (?:see|read|access|view)|without (?:seeing|access to)|no file (?:content|contents) (?:was|were) provided)\b/i;

/** True when a local draft reads as a refusal/uncertainty answer rather than a real one. */
export function looksLikeEscalation(text: string): boolean {
  return text.trim().length === 0 || REFUSAL_RE.test(text);
}

/** Wraps a local draft in a clearly-labeled, never-silent marker (Decision 25 risk mitigation). */
export function labelDraft(result: ChatResult): string {
  return `Local draft (${result.model}, unverified — a starting point, not an answer): ${result.text.trim()}`;
}

/** Append a labeled text block to an Anthropic `system` value (string, block array, or absent). */
export function appendSystemBlock(system: unknown, text: string): unknown {
  if (system === undefined || system === null) return text;
  if (typeof system === "string") return `${system}\n\n${text}`;
  if (Array.isArray(system)) return [...system, { type: "text", text }];
  return system;
}

async function callDrafter(
  inference: InferenceService,
  messages: readonly ChatMessage[],
): Promise<ChatResult | null> {
  if (messages.length === 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOCAL_INTERCEPT_TIMEOUT_MS);
  try {
    return await inference.chat("drafter", messages, { signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Mode A: run the drafter and return its labeled text, or null on any failure/empty draft. */
export async function runDraftStage(
  inference: InferenceService,
  body: Readonly<Record<string, unknown>>,
): Promise<string | null> {
  const messages = toLocalChatMessages(body.messages, body.system);
  const result = await callDrafter(inference, messages);
  if (result === null || result.text.trim().length === 0) return null;
  return labelDraft(result);
}

export type LocalFirstOutcome =
  | { readonly kind: "served"; readonly response: LocalResponse }
  | { readonly kind: "escalate"; readonly draftText: string | null };

function localMessageId(): string {
  return `msg_local_${randomUUID().replace(/-/g, "")}`;
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const ANSWERED_LOCALLY_PREFIX = (model: string): string =>
  `**Golem** Used ${model} locally — verify independently.\n\n`;

function buildLocalJsonResponse(result: ChatResult): LocalResponse {
  const text = `${ANSWERED_LOCALLY_PREFIX(result.model)}${result.text.trim()}`;
  const payload = {
    id: localMessageId(),
    type: "message",
    role: "assistant",
    model: result.model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: result.promptTokens, output_tokens: result.completionTokens },
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "content-length": String(body.length) },
    body,
  };
}

function buildLocalSseResponse(result: ChatResult): LocalResponse {
  const id = localMessageId();
  const text = `${ANSWERED_LOCALLY_PREFIX(result.model)}${result.text.trim()}`;
  const parts = [
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: result.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: result.promptTokens, output_tokens: 0 },
      },
    }),
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }),
    sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: result.completionTokens },
    }),
    sseEvent("message_stop", { type: "message_stop" }),
  ];
  const body = Buffer.from(parts.join(""), "utf8");
  return {
    statusCode: 200,
    headers: { "content-type": "text/event-stream", "content-length": String(body.length) },
    body,
  };
}

/**
 * Mode B: try to answer the request locally. Returns `served` with a
 * synthetic Anthropic Messages API response (shape matches
 * tests/integration/helpers/anthropic-fixtures.ts) when the draft looks like
 * a real answer, or `escalate` — carrying the rejected draft's labeled text
 * (Mode A's format) so the local compute still reaches Claude as context.
 */
export async function runLocalFirstStage(
  inference: InferenceService,
  body: Readonly<Record<string, unknown>>,
  streaming: boolean,
): Promise<LocalFirstOutcome> {
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return { kind: "escalate", draftText: null };
  }
  const messages = toLocalChatMessages(body.messages, body.system);
  const result = await callDrafter(inference, messages);
  if (result === null) return { kind: "escalate", draftText: null };
  const text = result.text.trim();
  if (text.length === 0) return { kind: "escalate", draftText: null };
  if (looksLikeEscalation(text)) {
    return { kind: "escalate", draftText: labelDraft(result) };
  }
  return {
    kind: "served",
    response: streaming ? buildLocalSseResponse(result) : buildLocalJsonResponse(result),
  };
}
