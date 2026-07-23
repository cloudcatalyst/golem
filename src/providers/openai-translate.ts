/**
 * R6.1 case (b), slice b1 — Anthropic Messages ↔ OpenAI Chat Completions
 * translation, NON-STREAMING only (spec Decision 22).
 *
 * This is the translating half of the provider work: an OpenAI-schema upstream
 * (OpenAI, or Ollama's OpenAI-compatible `/v1/chat/completions`, local or over
 * the LAN) does NOT speak the Anthropic protocol, so — unlike case (a) — the
 * request body and the response body must be converted. That conversion is the
 * proxy's "response-transform seam" (src/proxy), which is opt-in and NEVER on
 * the Anthropic path (byte-faithful hard rule).
 *
 * Scope of b1, deliberately narrow (see the follow-on slices):
 * - **Non-streaming only.** `stream` is forced off to the upstream; streaming
 *   translation (Anthropic SSE ↔ OpenAI deltas) is slice b2.
 * - **Text content only.** Tool-use / tool_result / image blocks are flattened
 *   to their text (best-effort) — faithful tool-use mapping is slice b3.
 * - The response reports the **real serving model id**, never a Claude name
 *   (honesty rail, cf. Decision 25).
 *
 * Boundary validation uses zod here BECAUSE we are already parsing/reserializing
 * (a translating provider, not the byte-faithful passthrough) — the CLAUDE.md
 * "no zod on proxy payloads" rule is about the fidelity path, which this is not.
 */

import { z } from "zod";

/** Minimal Anthropic Messages request shape we read (tolerant — extra keys ignored). */
const anthropicContentBlock = z.object({ type: z.string() }).catchall(z.unknown());
const anthropicMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(anthropicContentBlock)]),
});
const anthropicRequest = z
  .object({
    model: z.string().optional(),
    max_tokens: z.number().int().positive().optional(),
    system: z.union([z.string(), z.array(anthropicContentBlock)]).optional(),
    messages: z.array(anthropicMessage),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    stop_sequences: z.array(z.string()).optional(),
    stream: z.boolean().optional(),
  })
  .catchall(z.unknown());

/** Flatten Anthropic content (string or blocks) to plain text for b1. */
function flattenContent(content: string | Array<Record<string, unknown>>): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "tool_result") {
      // b1 best-effort: surface tool output as text so the turn still carries it.
      const c = block.content;
      if (typeof c === "string") parts.push(c);
      else if (Array.isArray(c)) {
        for (const b of c) {
          const bb = b as { type?: unknown; text?: unknown };
          if (bb.type === "text" && typeof bb.text === "string") parts.push(bb.text);
        }
      }
    } else if (block.type === "tool_use") {
      parts.push(`[tool_use ${String(block.name ?? "")}: ${JSON.stringify(block.input ?? {})}]`);
    }
    // image / other blocks are dropped in b1 (documented limitation).
  }
  return parts.join("\n");
}

/** An OpenAI Chat Completions message (b1: text content only). */
export interface OpenAIChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface OpenAIChatRequest {
  readonly model: string;
  readonly messages: OpenAIChatMessage[];
  /** Honors the client's request: streaming (b2) or not (b1). */
  readonly stream: boolean;
  /** When streaming, ask the upstream to emit a final usage chunk (OpenAI; ignored by lenient servers). */
  readonly stream_options?: { readonly include_usage: true };
  readonly max_tokens?: number;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly stop?: string[];
}

/**
 * Translate an Anthropic Messages request body (raw bytes) to an OpenAI Chat
 * Completions request object. `opts.model` overrides the request's model (Ollama
 * has no `claude-*` model, so the upstream model is configured, not inherited).
 * Throws on an unparseable body so the caller can fail open.
 */
export function anthropicToOpenAIChat(
  body: Buffer | null,
  opts: { readonly model?: string } = {},
): OpenAIChatRequest {
  if (body === null) throw new Error("empty request body");
  const parsed = anthropicRequest.parse(JSON.parse(body.toString("utf8")));

  const messages: OpenAIChatMessage[] = [];
  if (parsed.system !== undefined) {
    const systemText =
      typeof parsed.system === "string" ? parsed.system : flattenContent(parsed.system);
    if (systemText.length > 0) messages.push({ role: "system", content: systemText });
  }
  for (const m of parsed.messages) {
    messages.push({ role: m.role, content: flattenContent(m.content) });
  }

  const model = opts.model ?? parsed.model;
  if (model === undefined || model === "") {
    throw new Error("no upstream model: set proxy.upstream_model for this provider");
  }

  // Honor the client's stream flag (b2). Streaming also asks for a usage chunk.
  const stream = parsed.stream === true;
  const out: OpenAIChatRequest = { model, messages, stream };
  return {
    ...out,
    ...(stream ? { stream_options: { include_usage: true as const } } : {}),
    ...(parsed.max_tokens !== undefined ? { max_tokens: parsed.max_tokens } : {}),
    ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
    ...(parsed.top_p !== undefined ? { top_p: parsed.top_p } : {}),
    ...(parsed.stop_sequences !== undefined ? { stop: parsed.stop_sequences } : {}),
  };
}

/** Minimal OpenAI Chat Completions (non-streaming) response shape. */
const openAIResponse = z
  .object({
    id: z.string().optional(),
    model: z.string().optional(),
    choices: z
      .array(
        z.object({
          message: z
            .object({ role: z.string().optional(), content: z.string().nullable().optional() })
            .catchall(z.unknown()),
          finish_reason: z.string().nullable().optional(),
        }),
      )
      .min(1),
    usage: z
      .object({
        prompt_tokens: z.number().optional(),
        completion_tokens: z.number().optional(),
      })
      .optional(),
  })
  .catchall(z.unknown());

/** OpenAI finish_reason → Anthropic stop_reason. */
export function mapStopReason(finish: string | null | undefined): string {
  switch (finish) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    default:
      return "end_turn"; // "stop", "content_filter", null, unknown
  }
}

/** The Anthropic Messages (non-streaming) response object we synthesize. */
export interface AnthropicMessageResponse {
  readonly id: string;
  readonly type: "message";
  readonly role: "assistant";
  readonly model: string;
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly stop_reason: string;
  readonly stop_sequence: null;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

/**
 * Translate a non-streaming OpenAI Chat Completions response body (raw bytes)
 * into an Anthropic Messages response object. The `model` reported is the
 * upstream's REAL serving model (never a Claude name). `fallbackId`/`fallbackModel`
 * cover a response that omits them. Throws on an unparseable body.
 */
export function openAIChatToAnthropic(
  body: Buffer,
  fallback: { readonly id: string; readonly model: string },
): AnthropicMessageResponse {
  const parsed = openAIResponse.parse(JSON.parse(body.toString("utf8")));
  const choice = parsed.choices[0];
  const text = choice?.message.content ?? "";
  return {
    id: parsed.id ?? fallback.id,
    type: "message",
    role: "assistant",
    model: parsed.model ?? fallback.model,
    content: [{ type: "text", text: text ?? "" }],
    stop_reason: mapStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: parsed.usage?.prompt_tokens ?? 0,
      output_tokens: parsed.usage?.completion_tokens ?? 0,
    },
  };
}
