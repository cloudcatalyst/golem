/**
 * R6.1 case (b) — Anthropic Messages ↔ OpenAI Chat Completions translation
 * (spec Decision 22). Non-streaming request/response here; streaming lives in
 * openai-stream.ts.
 *
 * This is the translating half of the provider work: an OpenAI-schema upstream
 * (OpenAI, or Ollama's OpenAI-compatible `/v1/chat/completions`, local or over
 * the LAN) does NOT speak the Anthropic protocol, so — unlike case (a) — the
 * request and response bodies must be converted. That conversion is the proxy's
 * "response-transform seam" (src/proxy), which is opt-in and NEVER on the
 * Anthropic path (byte-faithful hard rule).
 *
 * Slices: b1 text (non-streaming), b2 streaming (openai-stream.ts), **b3
 * tool-use** — `tools`/`tool_choice`, `tool_use`↔`tool_calls`,
 * `tool_result`↔`role:"tool"`. Images are still dropped (documented). The
 * response reports the **real serving model id**, never a Claude name (honesty
 * rail, cf. Decision 25).
 *
 * Boundary validation uses zod here BECAUSE we are already parsing/reserializing
 * (a translating provider, not the byte-faithful passthrough) — the CLAUDE.md
 * "no zod on proxy payloads" rule is about the fidelity path, which this is not.
 */

import { z } from "zod";
import { estimateTokens } from "../compression/tokens.js";
import { stripVendorPrefix } from "./model-display.js";

/** Minimal Anthropic Messages request shape we read (tolerant — extra keys ignored). */
const anthropicContentBlock = z.object({ type: z.string() }).catchall(z.unknown());
// Anthropic allows mid-conversation `system` messages in the array (not just the
// top-level `system` field), and Claude Code uses them — so accept all three.
const anthropicMessage = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.union([z.string(), z.array(anthropicContentBlock)]),
});
const anthropicTool = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    input_schema: z.unknown().optional(),
  })
  .catchall(z.unknown());
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
    tools: z.array(anthropicTool).optional(),
    tool_choice: z.object({ type: z.string() }).catchall(z.unknown()).optional(),
  })
  .catchall(z.unknown());

type Block = Record<string, unknown>;

/** Extract plain text from Anthropic content (used for system + text parts). */
function textOf(content: string | Block[]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

/** Human-readable byte size for an image placeholder. Approximate on purpose. */
function approxImageBytes(b: Block): number {
  const src = b.source as { data?: unknown; url?: unknown } | undefined;
  if (typeof src?.data === "string") return Math.floor((src.data.length * 3) / 4);
  if (typeof src?.url === "string") return src.url.length;
  return 0;
}

function imageMediaType(b: Block): string {
  const src = b.source as { media_type?: unknown } | undefined;
  return typeof src?.media_type === "string" ? src.media_type : "image";
}

/**
 * One line standing in for an image the model will not receive. It must read as
 * an omission: a model told nothing about a missing screenshot will answer
 * confidently about something it never saw (R10.14).
 */
function imageOmittedMarker(b: Block, reason: string): string {
  const kb = Math.round(approxImageBytes(b) / 1024);
  return `[image omitted: ${imageMediaType(b)}, ~${kb} KB — ${reason}]`;
}

/** Placeholder for an image hoisted out of a tool_result into a following user turn. */
function imageHoistedMarker(b: Block): string {
  const kb = Math.round(approxImageBytes(b) / 1024);
  return `[image: ${imageMediaType(b)}, ~${kb} KB — attached in the next message]`;
}

/**
 * An Anthropic `tool_result`'s content, split into the text that can ride inside
 * an OpenAI `role:"tool"` message and any images that cannot.
 *
 * OpenAI's tool messages carry text only, so an image returned BY a tool (which
 * is exactly what Claude Code's `Read` of a `.png` produces) has to be hoisted
 * into a following user turn — or replaced by a marker when the model has no
 * vision. Before R10.14 it was neither: a non-text block fell through to
 * `JSON.stringify`, so a 500 KB screenshot was handed to the model as base64
 * PROSE. Three of those made one real conversation ~468k tokens of mostly
 * base64, and the model answered with nothing at all.
 */
function toolResultParts(
  content: unknown,
  vision: boolean | undefined,
): { readonly text: string; readonly images: Block[] } {
  if (typeof content === "string") return { text: content, images: [] };
  if (Array.isArray(content)) {
    const parts: string[] = [];
    const images: Block[] = [];
    for (const b of content) {
      const bb = b as Block;
      if (bb.type === "text" && typeof bb.text === "string") {
        parts.push(bb.text);
      } else if (bb.type === "image") {
        if (vision === false) {
          parts.push(imageOmittedMarker(bb, "this model has no vision support"));
        } else {
          parts.push(imageHoistedMarker(bb));
          images.push(bb);
        }
      } else {
        parts.push(JSON.stringify(b));
      }
    }
    return { text: parts.join("\n"), images };
  }
  return { text: content === undefined ? "" : JSON.stringify(content), images: [] };
}

/**
 * Sanitize a tool_use id for Anthropic's schema: `^[a-zA-Z0-9_-]+$`.
 * Upstreams (OpenRouter, Gemini) may return IDs with dots, colons, or other
 * characters Anthropic rejects. Replace each invalid character with `_` so the
 * id stays readable and unique — stripping would risk collisions.
 */
function sanitizeToolId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Parse a tool-call arguments string to an object; `{}` on invalid/empty JSON. */
function parseArgs(args: string | undefined): Record<string, unknown> {
  if (args === undefined || args === "") return {};
  try {
    const v = JSON.parse(args);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface OpenAIToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

/** An OpenAI content part (multimodal). b4-kimi: images pass through. */
export type OpenAIContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image_url"; readonly image_url: { readonly url: string } };

/** An OpenAI Chat Completions message. */
export interface OpenAIChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | OpenAIContentPart[] | null;
  readonly tool_call_id?: string;
  readonly tool_calls?: OpenAIToolCall[];
}

/** Reasoning depth for reasoning models (Kimi k3, o-series). */
export type OpenAIReasoningEffort = "low" | "high" | "max";

export interface OpenAITool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: unknown;
  };
}

export type OpenAIToolChoice =
  | "auto"
  | "none"
  | "required"
  | { readonly type: "function"; readonly function: { readonly name: string } };

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
  readonly tools?: OpenAITool[];
  readonly tool_choice?: OpenAIToolChoice;
  /** b4-kimi: reasoning depth for reasoning models (Kimi k3 etc.); omitted otherwise. */
  readonly reasoning_effort?: OpenAIReasoningEffort;
}

/**
 * Map an Anthropic `image` block to an OpenAI `image_url` part. Base64 → a
 * `data:` URI; a URL source passes through. An Anthropic Files-API `file`
 * source has no OpenAI equivalent and is dropped (documented limitation).
 */
function imagePart(b: Block): OpenAIContentPart | null {
  if (b.type !== "image") return null;
  const src = b.source as
    | { type?: string; media_type?: string; data?: string; url?: string }
    | undefined;
  if (src === undefined) return null;
  if (src.type === "base64" && typeof src.data === "string") {
    const mt = typeof src.media_type === "string" ? src.media_type : "image/png";
    return { type: "image_url", image_url: { url: `data:${mt};base64,${src.data}` } };
  }
  if (src.type === "url" && typeof src.url === "string") {
    return { type: "image_url", image_url: { url: src.url } };
  }
  return null;
}

/**
 * Combine collected text + image parts into OpenAI message content: a plain
 * string when there are no images (back-compat + most turns), else a parts
 * array. `null` when there is nothing at all.
 */
function combineContent(
  textParts: string[],
  imageParts: OpenAIContentPart[],
): string | OpenAIContentPart[] | null {
  if (imageParts.length === 0) return textParts.length > 0 ? textParts.join("\n") : null;
  const parts: OpenAIContentPart[] = [];
  if (textParts.length > 0) parts.push({ type: "text", text: textParts.join("\n") });
  parts.push(...imageParts);
  return parts;
}

/**
 * Translate Anthropic messages to OpenAI messages. One Anthropic message can
 * expand to several OpenAI messages: an assistant turn with `tool_use` blocks
 * becomes an assistant message carrying `tool_calls`; a user turn with
 * `tool_result` blocks becomes one `role:"tool"` message per result (emitted
 * before any user text, since they answer the prior assistant's tool calls).
 */
function translateMessages(
  messages: z.infer<typeof anthropicMessage>[],
  vision?: boolean | undefined,
): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = [];
  for (const m of messages) {
    // Mid-conversation system messages → OpenAI system messages (text only).
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : textOf(m.content as Block[]);
      if (text.length > 0) out.push({ role: "system", content: text });
      continue;
    }
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = m.content as Block[];
    if (m.role === "assistant") {
      const textParts: string[] = [];
      const imageParts: OpenAIContentPart[] = [];
      const toolCalls: OpenAIToolCall[] = [];
      for (const b of blocks) {
        if (b.type === "text" && typeof b.text === "string") {
          textParts.push(b.text);
        } else if (b.type === "image") {
          if (vision === false) {
            textParts.push(imageOmittedMarker(b, "this model has no vision support"));
          } else {
            const p = imagePart(b);
            if (p !== null) imageParts.push(p);
          }
        } else if (b.type === "tool_use") {
          toolCalls.push({
            id: String(b.id ?? ""),
            type: "function",
            function: { name: String(b.name ?? ""), arguments: JSON.stringify(b.input ?? {}) },
          });
        }
      }
      // An assistant turn with neither content nor tool_calls is malformed for
      // OpenAI-compatible endpoints, and a thinking-only turn produces exactly
      // that (thinking blocks have no OpenAI equivalent, so nothing survives).
      // 22 of them sat in one real transcript. Emit "" rather than null.
      const combined = combineContent(textParts, imageParts);
      const msg: OpenAIChatMessage = {
        role: "assistant",
        content: combined === null && toolCalls.length === 0 ? "" : combined,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
      out.push(msg);
    } else {
      const textParts: string[] = [];
      const imageParts: OpenAIContentPart[] = [];
      const toolMsgs: OpenAIChatMessage[] = [];
      // Images returned BY a tool. They cannot ride inside the role:"tool"
      // message, so they are hoisted into a user turn emitted after every tool
      // message for this turn — the tool replies must stay adjacent to the calls
      // they answer, or a strict upstream rejects the ordering.
      const hoisted: OpenAIContentPart[] = [];
      for (const b of blocks) {
        if (b.type === "text" && typeof b.text === "string") {
          textParts.push(b.text);
        } else if (b.type === "image") {
          if (vision === false) {
            textParts.push(imageOmittedMarker(b, "this model has no vision support"));
          } else {
            const p = imagePart(b);
            if (p !== null) imageParts.push(p);
          }
        } else if (b.type === "tool_result") {
          const { text, images } = toolResultParts(b.content, vision);
          toolMsgs.push({
            role: "tool",
            tool_call_id: String(b.tool_use_id ?? ""),
            content: text,
          });
          for (const img of images) {
            const p = imagePart(img);
            if (p !== null) hoisted.push(p);
          }
        }
      }
      for (const tm of toolMsgs) out.push(tm);
      if (hoisted.length > 0) {
        out.push({
          role: "user",
          content: [
            { type: "text", text: "Images returned by the tool call(s) above:" },
            ...hoisted,
          ],
        });
      }
      const content = combineContent(textParts, imageParts);
      if (content !== null) out.push({ role: "user", content });
    }
  }
  return out;
}

/** Anthropic tool_choice → OpenAI tool_choice (undefined when unrecognized). */
function translateToolChoice(tc: { type: string } | undefined): OpenAIToolChoice | undefined {
  if (tc === undefined) return undefined;
  switch (tc.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool": {
      const name = (tc as { name?: unknown }).name;
      return typeof name === "string" ? { type: "function", function: { name } } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Translate an Anthropic Messages request body (raw bytes) to an OpenAI Chat
 * Completions request object. `opts.model` overrides the request's model (Ollama
 * has no `claude-*` model, so the upstream model is configured, not inherited).
 * `opts.keepVendorPrefix` forwards a `vendor/model` id whole instead of stripping
 * the vendor segment — required for a multi-vendor gateway whose canonical ids
 * carry it (see `preservesVendorPrefix`). Throws on an unparseable body so the
 * caller can fail open.
 *
 * `opts.vision` is the model's image-input capability (R10.14): `false` replaces
 * every image with a short placeholder, `true` forwards them, and `undefined`
 * — the catalog does not say — forwards them too. Guessing "no vision" would
 * silently blind a model that can see, whereas forwarding to one that cannot
 * gets a clean upstream error naming the problem.
 */
export function anthropicToOpenAIChat(
  body: Buffer | null,
  opts: {
    readonly model?: string;
    readonly reasoningEffort?: OpenAIReasoningEffort;
    readonly keepVendorPrefix?: boolean;
    readonly vision?: boolean | undefined;
  } = {},
): OpenAIChatRequest {
  if (body === null) throw new Error("empty request body");
  const parsed = anthropicRequest.parse(JSON.parse(body.toString("utf8")));

  const messages: OpenAIChatMessage[] = [];
  if (parsed.system !== undefined) {
    const systemText = textOf(parsed.system as string | Block[]);
    if (systemText.length > 0) messages.push({ role: "system", content: systemText });
  }
  messages.push(...translateMessages(parsed.messages, opts.vision));

  const requestedModel = opts.model ?? parsed.model ?? "";
  const model = opts.keepVendorPrefix === true ? requestedModel : stripVendorPrefix(requestedModel);
  if (model === "") {
    throw new Error("no upstream model: set proxy.upstream_model for this provider");
  }

  const tools: OpenAITool[] | undefined = parsed.tools?.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      parameters: t.input_schema ?? {},
    },
  }));
  const toolChoice = translateToolChoice(parsed.tool_choice);

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
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(opts.reasoningEffort !== undefined ? { reasoning_effort: opts.reasoningEffort } : {}),
  };
}

/**
 * R10.15 — answer `POST /v1/messages/count_tokens` locally for an OpenAI-schema
 * upstream, which has no such endpoint.
 *
 * Before this, the proxy rewrote the path to `/v1/chat/completions` like any
 * other request, so asking "how many tokens is this prompt?" returned a full
 * assistant completion — and billed for it.
 *
 * The number is an ESTIMATE, not a count: `estimateTokens` is the deliberately
 * tokenizer-free ~4 chars/token heuristic (a real BPE vocabulary is a
 * heavyweight dependency the default install forbids). It is good enough for a
 * context meter and must not be presented as authoritative anywhere.
 *
 * Counted over what actually goes upstream: system text, every message's text
 * and tool_result text, and the tool definitions.
 */
/**
 * Nominal token cost of one image. Images do NOT tokenize by their encoded
 * length — a vision model bills roughly by pixel area — so counting a base64
 * `data:` URI as text overstates a single screenshot by ~100k tokens. Without
 * decoding the image there is no honest per-image number, so this is a flat,
 * openly-approximate stand-in in the right order of magnitude (Anthropic's own
 * guidance puts a ~1000×1000 image near 1.3k tokens).
 */
const IMAGE_TOKEN_ESTIMATE = 1_600;

export function countAnthropicInputTokens(body: Buffer | null): number {
  if (body === null) throw new Error("empty request body");
  const parsed = anthropicRequest.parse(JSON.parse(body.toString("utf8")));

  let total = 0;
  if (parsed.system !== undefined)
    total += estimateTokens(textOf(parsed.system as string | Block[]));
  // Translate first so the count reflects the messages the upstream will see —
  // including image placeholders rather than the base64 they replaced.
  for (const m of translateMessages(parsed.messages)) {
    const content = m.content;
    if (typeof content === "string") {
      total += estimateTokens(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        total += part.type === "text" ? estimateTokens(part.text) : IMAGE_TOKEN_ESTIMATE;
      }
    }
    for (const call of m.tool_calls ?? []) {
      total += estimateTokens(call.function.name) + estimateTokens(call.function.arguments);
    }
  }
  for (const t of parsed.tools ?? []) {
    total +=
      estimateTokens(t.name) +
      estimateTokens(t.description ?? "") +
      estimateTokens(t.input_schema === undefined ? "" : JSON.stringify(t.input_schema));
  }
  return total;
}

/** The Anthropic-shaped `count_tokens` response body. Nothing beyond what the API promises. */
export function countTokensResponse(body: Buffer | null): Buffer {
  return Buffer.from(JSON.stringify({ input_tokens: countAnthropicInputTokens(body) }), "utf8");
}

/** Minimal OpenAI Chat Completions (non-streaming) response shape. */
const openAIToolCall = z
  .object({
    id: z.string().optional(),
    function: z
      .object({ name: z.string().optional(), arguments: z.string().optional() })
      .optional(),
  })
  .catchall(z.unknown());
const openAIResponse = z
  .object({
    id: z.string().optional(),
    model: z.string().optional(),
    choices: z
      .array(
        z.object({
          message: z
            .object({
              role: z.string().optional(),
              content: z.string().nullable().optional(),
              // b4-kimi: reasoning models return the thinking trace here.
              reasoning_content: z.string().nullable().optional(),
              tool_calls: z.array(openAIToolCall).optional(),
            })
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

/** An Anthropic content block we emit (thinking, text, or tool_use). */
export type AnthropicOutBlock =
  | { readonly type: "thinking"; readonly thinking: string }
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    };

/** The Anthropic Messages (non-streaming) response object we synthesize. */
export interface AnthropicMessageResponse {
  readonly id: string;
  readonly type: "message";
  readonly role: "assistant";
  readonly model: string;
  readonly content: readonly AnthropicOutBlock[];
  readonly stop_reason: string;
  readonly stop_sequence: null;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

/**
 * R10.18 — the upstream returned a well-formed response carrying no content and
 * no tool calls. Distinct from a transport failure: the call succeeded and the
 * model produced nothing.
 */
export class EmptyCompletionError extends Error {
  readonly model: string;
  readonly finishReason: string | null;
  constructor(model: string, finishReason: string | null) {
    super(
      finishReason === "length"
        ? `upstream model "${model}" returned no content — it hit max_tokens before ` +
            "emitting any output; raise max_tokens or shorten the request"
        : `upstream model "${model}" returned an empty completion (no content, no tool calls)` +
            (finishReason === null ? "" : ` — finish_reason "${finishReason}"`),
    );
    this.name = "EmptyCompletionError";
    this.model = model;
    this.finishReason = finishReason;
  }
}

/**
 * Translate a non-streaming OpenAI Chat Completions response body (raw bytes)
 * into an Anthropic Messages response object. The `model` reported is the
 * upstream's REAL serving model (never a Claude name). `fallback` covers a
 * response that omits id/model. Throws on an unparseable body.
 */
export function openAIChatToAnthropic(
  body: Buffer,
  fallback: { readonly id: string; readonly model: string },
  opts: { readonly mapReasoning?: boolean } = {},
): AnthropicMessageResponse {
  const parsed = openAIResponse.parse(JSON.parse(body.toString("utf8")));
  const choice = parsed.choices[0];
  const text = choice?.message.content ?? "";
  const content: AnthropicOutBlock[] = [];
  // b4-kimi: a reasoning model's thinking trace → a leading Anthropic thinking
  // block (no signature — synthesized, non-Anthropic origin; display-only).
  const reasoning = choice?.message.reasoning_content;
  if (opts.mapReasoning !== false && typeof reasoning === "string" && reasoning.length > 0) {
    content.push({ type: "thinking", thinking: reasoning });
  }
  if (typeof text === "string" && text.length > 0) content.push({ type: "text", text });
  for (const tc of choice?.message.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: sanitizeToolId(tc.id ?? fallback.id),
      name: tc.function?.name ?? "",
      input: parseArgs(tc.function?.arguments),
    });
  }
  // R10.18: an upstream that produced NOTHING must not be dressed up as a valid
  // answer that happens to be empty. Manufacturing `{type:"text", text:""}` here
  // is what made the R10.14 failure undiagnosable: HTTP 200, end_turn,
  // output_tokens 0, and no way for a client to tell it from a model choosing to
  // say nothing — so Claude Code looped on it for a day. A thrown error becomes
  // a clean proxy error naming the model instead.
  //
  // Gate on content AND tool calls: a tool-only turn legitimately has no text.
  if (content.length === 0) {
    throw new EmptyCompletionError(parsed.model ?? fallback.model, choice?.finish_reason ?? null);
  }
  return {
    id: parsed.id ?? fallback.id,
    type: "message",
    role: "assistant",
    model: parsed.model ?? fallback.model,
    content,
    stop_reason: mapStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: parsed.usage?.prompt_tokens ?? 0,
      output_tokens: parsed.usage?.completion_tokens ?? 0,
    },
  };
}
