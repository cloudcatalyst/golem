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

/**
 * Max characters per embedding input (verification-notes §69 / PRE_R6_BATCH LE5).
 *
 * Embedding models process each input as a SINGLE physical batch, so an input
 * longer than the model's batch size (stock `bge-m3` on Ollama: 2048 tokens)
 * does not merely truncate — it errors (`input … is too large to process`) and
 * can crash the model runner, aborting the whole index build. Golem's chunker
 * only *soft*-caps chunk size (splits on paragraph boundaries), so a dense
 * unsplittable block (a wide markdown table, a long spec section) can exceed it.
 *
 * We bound each input to a conservative character budget that stays under a
 * 2048-token physical batch for latin/code text (~4 chars/token → ~1500 tokens,
 * leaving margin). The full chunk text is still STORED and returned by search;
 * only its embedding vector is computed from the head. Token-accurate bounding
 * (and a per-model batch probe) is a future refinement — CJK-dense text packs
 * more tokens per char and may need a smaller cap.
 */
export const MAX_EMBED_INPUT_CHARS = 6000;

/**
 * Max inputs per `/v1/embeddings` request (verification-notes §69 / LE5). A
 * full-project reindex embeds thousands of chunks; sending them as one request
 * makes Ollama open a per-input localhost connection to its runner and exhausts
 * ephemeral ports/TIME_WAIT on Windows mid-request. Batching keeps each request
 * short and lets connections drain. 64 is a safe, conservative default.
 */
export const EMBED_BATCH_SIZE = 64;

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
  /**
   * R8.15 — the origin this client is bound to. Exposed so the service can tell
   * whether a resolved provider endpoint is already served by this client or needs
   * its own; the paths are always `/v1/...`, so a `base_url` carrying a `/v1`
   * suffix collapses to the same origin and is correctly treated as the same
   * endpoint.
   */
  readonly origin: string;

  constructor(options: OllamaClientOptions = {}) {
    const base = new URL(options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL);
    this.origin = base.origin;
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
    // Bound each input so an oversized chunk cannot exceed the model's physical
    // batch and crash the runner (see MAX_EMBED_INPUT_CHARS).
    const bounded = input.map((t) =>
      t.length > MAX_EMBED_INPUT_CHARS ? t.slice(0, MAX_EMBED_INPUT_CHARS) : t,
    );
    // Send in bounded batches rather than one giant request. A full-project
    // reindex embeds thousands of chunks; posting them all in a single
    // `/v1/embeddings` call makes Ollama open a localhost connection to its
    // model runner per input, and after ~a minute of rapid connections the dial
    // starts getting refused (Windows ephemeral-port/TIME_WAIT exhaustion),
    // 400ing the whole request and losing all progress (verification-notes §69 /
    // PRE_R6_BATCH LE5). Sequential batches keep each request short and let
    // connections drain between them. Sequential (not parallel) on purpose — the
    // single local runner has no concurrency to exploit.
    const out: number[][] = [];
    for (let i = 0; i < bounded.length; i += EMBED_BATCH_SIZE) {
      const batch = await this.#embedBatch(model, bounded.slice(i, i + EMBED_BATCH_SIZE));
      out.push(...batch);
    }
    return out;
  }

  /** One `/v1/embeddings` request for a single bounded batch. */
  async #embedBatch(model: string, input: readonly string[]): Promise<number[][]> {
    if (input.length === 0) return [];
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
