/**
 * WS-D D2 — Ollama client over its OpenAI-compatible endpoints
 * (`/v1/chat/completions`, `/v1/embeddings`). Base URL is configurable so the
 * "LAN lab box" story (spec Decision 12) works: point it at any OpenAI-compat
 * server. Uses undici (already a dependency); no heavyweight deps.
 *
 * This is the transport only — role→model selection and fallback live in the
 * InferenceService (D3). Errors are typed so the service can decide whether to
 * fall back or surface them.
 */

import { Pool } from "undici";

/** The endpoint is missing a model that must be pulled first. */
export class ModelNotAvailableError extends Error {
  constructor(readonly model: string) {
    super(
      `model "${model}" is not available on the inference endpoint; ` +
        `pull it first (e.g. \`ollama pull ${model}\`)`,
    );
    this.name = "ModelNotAvailableError";
  }
}

/** The inference endpoint could not be reached at all. */
export class InferenceEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InferenceEndpointError";
  }
}

/**
 * The request reached the endpoint but did not complete within
 * `requestTimeoutMs`. Distinct from {@link InferenceEndpointError} (dead
 * endpoint) and {@link ModelNotAvailableError} (model not pulled) so callers
 * can report the ACTUAL failure — a slow/cold local model is neither "endpoint
 * down" nor "no model at this tier" (verification-notes §66). Local generation
 * here is non-streaming, so this bound covers the whole completion; a cold 7B
 * load plus a grounded draft on slow hardware can hit it legitimately.
 */
export class InferenceTimeoutError extends InferenceEndpointError {
  constructor(readonly timeoutMs: number) {
    super(
      `local inference timed out after ${timeoutMs}ms — the model may be cold-loading or the ` +
        "hardware is slow for this request. Raise `inference.request_timeout_ms` " +
        "(env GOLEM_INFERENCE_REQUEST_TIMEOUT_MS) if this is expected on this machine.",
    );
    this.name = "InferenceTimeoutError";
  }
}

/** undici surfaces headers/body timeouts with these error codes. */
function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return (
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    err.name === "HeadersTimeoutError" ||
    err.name === "BodyTimeoutError"
  );
}

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

export interface OllamaClientOptions {
  readonly baseUrl?: string;
  readonly requestTimeoutMs?: number;
}

export interface ChatCompletionParams {
  readonly model: string;
  readonly messages: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly jsonSchema?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

export interface ChatCompletion {
  readonly text: string;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly finishReason: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Ollama returns 404 with a "not found"/"try pulling" message for absent models. */
function looksLikeMissingModel(status: number, body: string): boolean {
  if (status !== 404) return false;
  const b = body.toLowerCase();
  return b.includes("not found") || b.includes("try pulling") || b.includes("no such model");
}

export class OllamaClient {
  readonly #pool: Pool;
  readonly #timeoutMs: number;

  constructor(options: OllamaClientOptions = {}) {
    const base = new URL(options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL);
    this.#pool = new Pool(base.origin);
    this.#timeoutMs = options.requestTimeoutMs ?? 120_000;
  }

  async close(): Promise<void> {
    await this.#pool.close();
  }

  async #postJson(path: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    let res: Awaited<ReturnType<Pool["request"]>>;
    try {
      res = await this.#pool.request({
        path,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        headersTimeout: this.#timeoutMs,
        bodyTimeout: this.#timeoutMs,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (isTimeoutError(err)) throw new InferenceTimeoutError(this.#timeoutMs);
      throw new InferenceEndpointError(
        `could not reach inference endpoint: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const body = await res.body.text();
    if (res.statusCode >= 400) {
      const model = isRecord(payload) && typeof payload.model === "string" ? payload.model : "";
      if (looksLikeMissingModel(res.statusCode, body)) {
        throw new ModelNotAvailableError(model);
      }
      throw new InferenceEndpointError(`inference endpoint returned ${res.statusCode}: ${body}`);
    }
    try {
      return JSON.parse(body);
    } catch {
      throw new InferenceEndpointError(`inference endpoint returned non-JSON body: ${body}`);
    }
  }

  async chat(params: ChatCompletionParams): Promise<ChatCompletion> {
    const payload: Record<string, unknown> = {
      model: params.model,
      messages: params.messages,
      stream: false,
    };
    if (params.temperature !== undefined) payload.temperature = params.temperature;
    if (params.maxTokens !== undefined) payload.max_tokens = params.maxTokens;
    if (params.jsonSchema !== undefined) {
      payload.response_format = { type: "json_schema", json_schema: params.jsonSchema };
    }

    const json = await this.#postJson("/v1/chat/completions", payload, params.signal);
    if (!isRecord(json) || !Array.isArray(json.choices) || json.choices.length === 0) {
      throw new InferenceEndpointError("chat response missing choices");
    }
    const choice = json.choices[0] as Record<string, unknown>;
    const message = isRecord(choice.message) ? choice.message : {};
    const usage = isRecord(json.usage) ? json.usage : {};
    return {
      text: typeof message.content === "string" ? message.content : "",
      model: typeof json.model === "string" ? json.model : params.model,
      promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
      completionTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
      finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : "stop",
    };
  }

  async embed(model: string, input: readonly string[]): Promise<number[][]> {
    const json = await this.#postJson("/v1/embeddings", { model, input });
    if (!isRecord(json) || !Array.isArray(json.data)) {
      throw new InferenceEndpointError("embeddings response missing data");
    }
    // OpenAI shape: data is [{ index, embedding: number[] }, ...], order not
    // guaranteed — sort by index to align with the input order.
    const rows = json.data
      .filter(isRecord)
      .map((row) => ({
        index: typeof row.index === "number" ? row.index : 0,
        embedding: Array.isArray(row.embedding) ? (row.embedding as number[]) : [],
      }))
      .sort((a, b) => a.index - b.index);
    return rows.map((r) => r.embedding);
  }
}
