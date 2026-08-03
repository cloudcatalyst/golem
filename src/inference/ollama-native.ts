/**
 * WS-D — Ollama's native HTTP API (`/api/tags`, `/api/pull`), used to check
 * daemon reachability, list/verify pulled models, and pull a model with
 * progress. Kept separate from `ollama-client.ts`, which is deliberately
 * scoped to Ollama's OpenAI-compatible endpoints only.
 */

import { request } from "undici";
import { DEFAULT_OLLAMA_BASE_URL } from "./ollama-client.js";

/** The Ollama daemon could not be reached at all (connection refused, DNS, etc). */
export class OllamaUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaUnreachableError";
  }
}

/** The daemon was reached but a pull failed (bad model name, disk full, etc). */
export class OllamaPullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaPullError";
  }
}

export interface OllamaNativeClientOptions {
  readonly baseUrl?: string;
  readonly requestTimeoutMs?: number;
}

export interface PulledModel {
  readonly name: string;
  readonly sizeBytes: number;
}

/** One line of Ollama's NDJSON `/api/pull` stream. */
export interface PullProgressEvent {
  readonly status: string;
  readonly digest?: string;
  readonly total?: number;
  readonly completed?: number;
  readonly error?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Pure — parse one NDJSON line from `/api/pull`. Blank/unparseable lines are null. */
export function parsePullProgressLine(line: string): PullProgressEvent | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(json)) return null;
  const status = typeof json.status === "string" ? json.status : "";
  const error = typeof json.error === "string" ? json.error : undefined;
  if (status === "" && error === undefined) return null;
  return {
    status,
    ...(typeof json.digest === "string" && { digest: json.digest }),
    ...(typeof json.total === "number" && { total: json.total }),
    ...(typeof json.completed === "number" && { completed: json.completed }),
    ...(error !== undefined && { error }),
  };
}

/**
 * How long a `/api/pull` request may take to produce its first byte. Pulling a
 * multi-GB model can take a while to even begin streaming on a busy or LAN
 * Ollama instance, and the model download itself is bounded only by
 * `bodyTimeout: 0` (streaming). 30s is generous for the headers phase while
 * still failing fast on a genuinely dead daemon.
 */
const PULL_HEADERS_TIMEOUT_MS = 30_000;

export class OllamaNativeClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(options: OllamaNativeClientOptions = {}) {
    this.#baseUrl = options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL;
    this.#timeoutMs = options.requestTimeoutMs ?? 5_000;
  }

  async isReachable(): Promise<boolean> {
    try {
      await this.listModels();
      return true;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<readonly PulledModel[]> {
    let res: Awaited<ReturnType<typeof request>>;
    try {
      res = await request(new URL("/api/tags", this.#baseUrl), {
        method: "GET",
        headersTimeout: this.#timeoutMs,
        bodyTimeout: this.#timeoutMs,
      });
    } catch (err) {
      throw new OllamaUnreachableError(
        `could not reach Ollama at ${this.#baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const body = await res.body.text();
    if (res.statusCode >= 400) {
      throw new OllamaUnreachableError(`Ollama returned ${res.statusCode} for /api/tags: ${body}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new OllamaUnreachableError(`Ollama returned a non-JSON /api/tags body: ${body}`);
    }
    if (!isRecord(json) || !Array.isArray(json.models)) return [];
    return json.models
      .filter(isRecord)
      .filter((m): m is Record<string, unknown> & { name: string } => typeof m.name === "string")
      .map((m) => ({
        name: m.name,
        sizeBytes: typeof m.size === "number" ? m.size : 0,
      }));
  }

  async hasModel(modelName: string): Promise<boolean> {
    const models = await this.listModels();
    return models.some((m) => m.name.startsWith(modelName));
  }

  async pull(
    modelName: string,
    onProgress?: (event: PullProgressEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    let res: Awaited<ReturnType<typeof request>>;
    try {
      res = await request(new URL("/api/pull", this.#baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: modelName, stream: true }),
        // The general request timeout is too tight for a pull's headers phase —
        // a busy or LAN Ollama can take >5s to begin streaming. See
        // PULL_HEADERS_TIMEOUT_MS.
        headersTimeout: PULL_HEADERS_TIMEOUT_MS,
        bodyTimeout: 0, // pulling a multi-GB model can take a long time
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throw new OllamaUnreachableError(
        `could not reach Ollama at ${this.#baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.statusCode >= 400) {
      const body = await res.body.text();
      throw new OllamaPullError(`Ollama returned ${res.statusCode} for /api/pull: ${body}`);
    }

    let buffer = "";
    for await (const chunk of res.body) {
      buffer += (chunk as Buffer).toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const handled = this.#handlePullLine(buffer.slice(0, newlineIndex), onProgress);
        buffer = buffer.slice(newlineIndex + 1);
        if (handled) return;
        newlineIndex = buffer.indexOf("\n");
      }
    }
    if (this.#handlePullLine(buffer, onProgress)) return;
    throw new OllamaPullError("ollama pull stream ended without a success status");
  }

  /** Returns true when the stream is done (success). Throws OllamaPullError on an error line. */
  #handlePullLine(line: string, onProgress?: (event: PullProgressEvent) => void): boolean {
    const event = parsePullProgressLine(line);
    if (event === null) return false;
    if (event.error !== undefined) throw new OllamaPullError(`ollama pull failed: ${event.error}`);
    onProgress?.(event);
    return event.status === "success";
  }
}
