/**
 * R8.15 — the OpenAI-compatible *native* surface: `/v1/models` and llama.cpp's
 * `/props`.
 *
 * `ollama-native.ts` is the same idea for Ollama (`/api/tags`, `/api/pull`), and the
 * two are kept apart for the same reason: `ollama-client.ts` speaks only the
 * protocol that every backend shares, and everything backend-specific lives beside
 * it rather than inside it.
 *
 * **What this can and cannot tell you.** `/v1/models` lists ids, and for Ollama or
 * LM Studio with several models loaded that list is meaningful. For a llama.cpp
 * server it usually is not: it serves whichever GGUF was loaded regardless of the id
 * you send, so the id in a provider entry is the user's handle for it, not a lookup
 * key. That is why `matchesListedModel` answers `"unknown"` for an unlisted id on a
 * reachable non-Ollama endpoint instead of `"not-pulled"` — the same three-state
 * honesty `availability.ts` already enforces. A confident "missing" we cannot
 * actually verify is the dishonest zero this repo keeps designing out.
 */

import { request } from "undici";
import { InferenceEndpointError } from "./ollama-client.js";

/** Default budget for a status-surface probe: short, because a human is waiting. */
export const DEFAULT_MODELS_TIMEOUT_MS = 2500;

export interface OpenAiModelsClientOptions {
  readonly baseUrl: string;
  readonly requestTimeoutMs?: number;
  /** Value for `Authorization: Bearer …`. Local servers ignore it; some clients demand one. */
  readonly apiKey?: string;
}

/** llama.cpp `/props` — only the parts Golem has a use for. */
export interface ServerProps {
  /** The live context window the server was launched with (`-c`). */
  readonly contextWindow?: number;
  /** Model path/name the server reports, when it reports one. */
  readonly modelPath?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Strip a trailing slash so `${base}/v1/models` never doubles up. */
function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * `/v1/models` lives under the `/v1` prefix, but a provider's `base_url` may or may
 * not already carry it (Ollama wants the bare host, llama.cpp is conventionally
 * given `…:8888/v1`). Normalise rather than making the user guess which we expect.
 */
export function modelsUrl(baseUrl: string): string {
  const base = trimSlash(baseUrl);
  return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
}

/**
 * `/props` is llama.cpp's own endpoint and is NOT under `/v1` — it sits at the
 * server root, so a `/v1`-suffixed base URL has to have that stripped back off.
 */
export function propsUrl(baseUrl: string): string {
  const base = trimSlash(baseUrl);
  return `${base.endsWith("/v1") ? base.slice(0, -3) : base}/props`;
}

/** Pure — pull the model ids out of an OpenAI `/v1/models` body. */
export function parseModelsResponse(body: unknown): readonly string[] {
  if (!isRecord(body) || !Array.isArray(body.data)) return [];
  const ids: string[] = [];
  for (const entry of body.data) {
    if (isRecord(entry) && typeof entry.id === "string" && entry.id !== "") ids.push(entry.id);
  }
  return ids;
}

/**
 * Pure — pull the live context window out of a llama.cpp `/props` body.
 *
 * llama.cpp has moved this field around across versions, so all three known spellings
 * are accepted. Nothing is inferred: an unrecognised body yields `{}`, and the caller
 * reports the window as unknown rather than substituting a plausible number.
 */
export function parsePropsResponse(body: unknown): ServerProps {
  if (!isRecord(body)) return {};
  const settings = isRecord(body.default_generation_settings)
    ? body.default_generation_settings
    : undefined;
  // Top level first: on a server running several slots, `default_generation_settings.n_ctx`
  // is the PER-SLOT window, which is not what a caller budgeting a request wants.
  let contextWindow: number | undefined;
  for (const c of [body.n_ctx, settings?.n_ctx]) {
    if (typeof c === "number" && Number.isInteger(c) && c > 0) {
      contextWindow = c;
      break;
    }
  }
  const modelPath =
    typeof body.model_path === "string"
      ? body.model_path
      : typeof body.model === "string"
        ? body.model
        : undefined;
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(modelPath !== undefined ? { modelPath } : {}),
  };
}

/** Read-only client for an OpenAI-compatible server's native surface. */
export class OpenAiModelsClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #apiKey: string | undefined;

  constructor(options: OpenAiModelsClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#timeoutMs = options.requestTimeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS;
    this.#apiKey = options.apiKey;
  }

  async #getJson(url: string): Promise<unknown> {
    let res: Awaited<ReturnType<typeof request>>;
    try {
      res = await request(url, {
        method: "GET",
        headersTimeout: this.#timeoutMs,
        bodyTimeout: this.#timeoutMs,
        headers: this.#apiKey === undefined ? {} : { authorization: `Bearer ${this.#apiKey}` },
      });
    } catch (err) {
      throw new InferenceEndpointError(
        `could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      // Drain so the socket is not held open for the pool's idle timeout.
      await res.body.dump();
      throw new InferenceEndpointError(`${url} returned HTTP ${res.statusCode}`);
    }
    try {
      return await res.body.json();
    } catch (err) {
      throw new InferenceEndpointError(
        `${url} returned a body that is not JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Model ids the server reports. Throws {@link InferenceEndpointError} if it cannot be asked. */
  async listModels(): Promise<readonly string[]> {
    return parseModelsResponse(await this.#getJson(modelsUrl(this.#baseUrl)));
  }

  /**
   * llama.cpp's `/props`. Returns `{}` on any server that does not implement it —
   * absence is a fact about the backend, not an error worth propagating to a status
   * command, and every other backend in scope simply lacks the endpoint.
   */
  async props(): Promise<ServerProps> {
    try {
      return parsePropsResponse(await this.#getJson(propsUrl(this.#baseUrl)));
    } catch {
      return {};
    }
  }
}
