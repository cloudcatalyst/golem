/**
 * R6.1 case (b) slice b4-gemini — Anthropic Messages ↔ Google Gemini
 * `generateContent` translation (spec Decision 22; API verified
 * verification-notes §77).
 *
 * Gemini is a SECOND upstream schema, distinct from OpenAI Chat Completions:
 * - **Auth** is an API key **query param** (`?key=`), not a header — so it rides
 *   the translator's per-request `path`, not the `mapUpstreamHeaders` seam.
 * - **Path** embeds the model + method: `/v1beta/models/{model}:generateContent`
 *   (non-stream) or `:streamGenerateContent?alt=sse` (stream, SSE).
 * - **Shape:** `contents[{role:"user"|"model", parts:[{text}|{functionCall}|
 *   {functionResponse}]}]`, `systemInstruction`, `generationConfig`,
 *   `tools[{functionDeclarations}]`, `toolConfig.functionCallingConfig`.
 *
 * Non-streaming request/response here; streaming lives in gemini-stream.ts. Like
 * the OpenAI translator, this NEVER runs on the Anthropic passthrough, reports
 * the real serving model, and validates its boundary with zod (it parses/
 * reserializes — not the byte-faithful path).
 */

import { z } from "zod";
import { stripVendorPrefix } from "./model-display.js";

const block = z.object({ type: z.string() }).catchall(z.unknown());
// Anthropic allows mid-conversation `system` messages; Gemini `contents` has no
// system role, so they fold into a `user` turn (the role mapping below).
const message = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.union([z.string(), z.array(block)]),
});
const tool = z
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
    system: z.union([z.string(), z.array(block)]).optional(),
    messages: z.array(message),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    stop_sequences: z.array(z.string()).optional(),
    stream: z.boolean().optional(),
    tools: z.array(tool).optional(),
    tool_choice: z.object({ type: z.string() }).catchall(z.unknown()).optional(),
  })
  .catchall(z.unknown());

type Block = Record<string, unknown>;

function textOf(content: string | Block[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/** Wrap an Anthropic tool_result `content` into Gemini's functionResponse.response object. */
function functionResponseObject(content: unknown): Record<string, unknown> {
  if (content !== null && typeof content === "object" && !Array.isArray(content)) {
    return content as Record<string, unknown>;
  }
  if (typeof content === "string") return { content };
  if (Array.isArray(content)) {
    const text = content
      .map((b) => {
        const bb = b as { type?: unknown; text?: unknown };
        return bb.type === "text" && typeof bb.text === "string" ? bb.text : JSON.stringify(b);
      })
      .join("\n");
    return { content: text };
  }
  return { content: "" };
}

/** Build a tool_use_id → tool name map from every assistant tool_use block in the request. */
function toolNameById(messages: z.infer<typeof message>[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const b of m.content as Block[]) {
      if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
        map.set(b.id, b.name);
      }
    }
  }
  return map;
}

interface GeminiPart {
  readonly text?: string;
  readonly functionCall?: { readonly name: string; readonly args: Record<string, unknown> };
  readonly functionResponse?: {
    readonly name: string;
    readonly response: Record<string, unknown>;
  };
}
interface GeminiContent {
  readonly role: "user" | "model";
  readonly parts: GeminiPart[];
}

export interface GeminiRequest {
  readonly contents: GeminiContent[];
  readonly systemInstruction?: { readonly parts: Array<{ readonly text: string }> };
  readonly generationConfig?: Record<string, unknown>;
  readonly tools?: Array<{ readonly functionDeclarations: unknown[] }>;
  readonly toolConfig?: {
    readonly functionCallingConfig: {
      readonly mode: string;
      readonly allowedFunctionNames?: string[];
    };
  };
}

/** Anthropic messages → Gemini `contents`. */
function translateContents(
  messages: z.infer<typeof message>[],
  names: Map<string, string>,
): GeminiContent[] {
  const out: GeminiContent[] = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";
    const parts: GeminiPart[] = [];
    if (typeof m.content === "string") {
      if (m.content.length > 0) parts.push({ text: m.content });
    } else {
      for (const b of m.content as Block[]) {
        if (b.type === "text" && typeof b.text === "string") {
          parts.push({ text: b.text });
        } else if (b.type === "tool_use") {
          parts.push({
            functionCall: {
              name: String(b.name ?? ""),
              args: (b.input ?? {}) as Record<string, unknown>,
            },
          });
        } else if (b.type === "tool_result") {
          const id = String(b.tool_use_id ?? "");
          parts.push({
            functionResponse: {
              name: names.get(id) ?? id,
              response: functionResponseObject(b.content),
            },
          });
        }
      }
    }
    if (parts.length > 0) out.push({ role, parts });
  }
  return out;
}

/** Anthropic tool_choice → Gemini functionCallingConfig. */
function translateToolConfig(
  tc: { type: string } | undefined,
): GeminiRequest["toolConfig"] | undefined {
  if (tc === undefined) return undefined;
  switch (tc.type) {
    case "auto":
      return { functionCallingConfig: { mode: "AUTO" } };
    case "any":
      return { functionCallingConfig: { mode: "ANY" } };
    case "none":
      return { functionCallingConfig: { mode: "NONE" } };
    case "tool": {
      const name = (tc as { name?: unknown }).name;
      return typeof name === "string"
        ? { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [name] } }
        : { functionCallingConfig: { mode: "ANY" } };
    }
    default:
      return undefined;
  }
}

/** The upstream path (with model + method + `alt=sse` + `?key=`) for a Gemini request. */
export function geminiPath(
  baseUrl: string,
  model: string,
  stream: boolean,
  apiKey: string | undefined,
): string {
  const prefix = new URL(baseUrl).pathname.replace(/\/+$/, "");
  const method = stream ? "streamGenerateContent" : "generateContent";
  const params = new URLSearchParams();
  if (stream) params.set("alt", "sse");
  if (apiKey !== undefined && apiKey !== "") params.set("key", apiKey);
  const qs = params.toString();
  return `${prefix}/models/${encodeURIComponent(model)}:${method}${qs ? `?${qs}` : ""}`;
}

/**
 * Translate an Anthropic Messages request body to a Gemini `generateContent`
 * request. Returns the body plus whether the client asked to stream (the caller
 * builds the path with {@link geminiPath}). Throws on an unparseable body.
 */
export function anthropicToGemini(
  body: Buffer | null,
  opts: { readonly model?: string } = {},
): { readonly body: GeminiRequest; readonly stream: boolean; readonly model: string } {
  if (body === null) throw new Error("empty request body");
  const parsed = anthropicRequest.parse(JSON.parse(body.toString("utf8")));

  const model = stripVendorPrefix(opts.model ?? parsed.model ?? "");
  if (model === "") {
    throw new Error("no upstream model: set proxy.upstream_model for this provider");
  }

  const names = toolNameById(parsed.messages);
  const contents = translateContents(parsed.messages, names);

  const generationConfig: Record<string, unknown> = {};
  if (parsed.max_tokens !== undefined) generationConfig.maxOutputTokens = parsed.max_tokens;
  if (parsed.temperature !== undefined) generationConfig.temperature = parsed.temperature;
  if (parsed.top_p !== undefined) generationConfig.topP = parsed.top_p;
  if (parsed.stop_sequences !== undefined) generationConfig.stopSequences = parsed.stop_sequences;

  const tools = parsed.tools?.map((t) => ({
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    parameters: t.input_schema ?? {},
  }));

  const systemText = parsed.system !== undefined ? textOf(parsed.system as string | Block[]) : "";
  const toolConfig = translateToolConfig(parsed.tool_choice);

  const req: GeminiRequest = {
    contents,
    ...(systemText.length > 0 ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
    ...(tools !== undefined && tools.length > 0
      ? { tools: [{ functionDeclarations: tools }] }
      : {}),
    ...(toolConfig !== undefined ? { toolConfig } : {}),
  };
  return { body: req, stream: parsed.stream === true, model };
}

/** Gemini finishReason → Anthropic stop_reason (tool_use is detected from parts, not here). */
export function mapGeminiFinish(reason: string | null | undefined): string {
  switch (reason) {
    case "MAX_TOKENS":
      return "max_tokens";
    default:
      return "end_turn"; // STOP, SAFETY, null, unknown
  }
}

/** Minimal Gemini `GenerateContentResponse` shape (non-streaming). */
const geminiPartSchema = z
  .object({
    text: z.string().optional(),
    functionCall: z
      .object({ name: z.string().optional(), args: z.record(z.unknown()).optional() })
      .optional(),
  })
  .catchall(z.unknown());
const geminiResponse = z
  .object({
    modelVersion: z.string().optional(),
    responseId: z.string().optional(),
    candidates: z
      .array(
        z
          .object({
            content: z.object({ parts: z.array(geminiPartSchema).optional() }).optional(),
            finishReason: z.string().nullable().optional(),
          })
          .catchall(z.unknown()),
      )
      .optional(),
    usageMetadata: z
      .object({
        promptTokenCount: z.number().optional(),
        candidatesTokenCount: z.number().optional(),
      })
      .optional(),
  })
  .catchall(z.unknown());

export type AnthropicOutBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    };

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
 * Translate a non-streaming Gemini response body into an Anthropic Messages
 * response. Gemini `functionCall`s have no id, so one is synthesized
 * (`call_<n>`) — it round-trips because the next request's history carries it on
 * the tool_use block, from which {@link toolNameById} recovers the name.
 */
export function geminiToAnthropic(
  body: Buffer,
  fallback: { readonly id: string; readonly model: string },
): AnthropicMessageResponse {
  const parsed = geminiResponse.parse(JSON.parse(body.toString("utf8")));
  const candidate = parsed.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const content: AnthropicOutBlock[] = [];
  let toolCount = 0;
  let sawTool = false;
  for (const p of parts) {
    if (typeof p.text === "string" && p.text.length > 0) {
      content.push({ type: "text", text: p.text });
    } else if (p.functionCall !== undefined) {
      sawTool = true;
      content.push({
        type: "tool_use",
        id: `call_${toolCount++}`,
        name: p.functionCall.name ?? "",
        input: p.functionCall.args ?? {},
      });
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return {
    id: parsed.responseId ?? fallback.id,
    type: "message",
    role: "assistant",
    model: parsed.modelVersion ?? fallback.model,
    content,
    stop_reason: sawTool ? "tool_use" : mapGeminiFinish(candidate?.finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: parsed.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: parsed.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}
