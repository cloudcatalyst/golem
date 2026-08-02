/**
 * Upstream model context-window cache + enforcement (R6.1 case b).
 *
 * **Problem:** When Claude Code talks to a translating provider (OpenRouter,
 * OpenAI, Ollama), it sends `model: "claude-opus-5[1m]"` and tracks context
 * against Claude's ~200K window. But the upstream model may have a much smaller
 * window (e.g. 131K for `poolside/laguna-s-2.1:free`, 32K for many OpenRouter
 * models). The compression pipeline shrinks context but doesn't enforce a hard
 * limit against the upstream's actual window.
 *
 * **Solution:** Before forwarding a `/v1/messages` request to a translating
 * provider, the proxy checks the request's estimated token count against the
 * upstream model's cached context window. If the request would exceed ~90% of
 * that window, the proxy returns a synthetic Anthropic
 * `context_length_exceeded` error. This makes Claude Code trigger its own
 * compaction/truncation mechanism — prompting the user before the upstream
 * rejects mid-stream or silently truncates.
 *
 * The cache is time-based (10-minute TTL). A stale/missing cache is fail-open:
 * the check is skipped, preserving the byte-faithful default.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { request } from "undici";
import { estimateTokens } from "../compression/tokens.js";

/** Stale after 10 minutes — context windows rarely change, but we re-check periodically. */
export const CONTEXT_WINDOW_CACHE_TTL_MS = 10 * 60_000;

const CONTEXT_WINDOW_CACHE_FILE = "upstream-context-window.json";

/** `.golem/state/` cache file for the upstream context window. */
function contextWindowPath(projectDir: string): string {
  return join(projectDir, ".golem", "state", CONTEXT_WINDOW_CACHE_FILE);
}

interface CachedWindow {
  /** The upstream model id (e.g. `poolside/laguna-s-2.1:free`). */
  readonly modelId: string;
  /** The real context window token count. */
  readonly contextWindow: number;
  /** ISO timestamp of the last fetch. */
  readonly fetchedAt: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Read the cached context window, or null if missing/corrupt/stale. */
export async function readCachedContextWindow(
  projectDir: string,
  modelId: string,
  nowMs: number = Date.now(),
): Promise<number | null> {
  let raw: string;
  try {
    raw = await readFile(contextWindowPath(projectDir), "utf8");
  } catch {
    return null;
  }
  try {
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(stripped) as unknown;
    if (!isRecord(parsed)) return null;
    if (parsed.modelId !== modelId) return null;
    if (typeof parsed.contextWindow !== "number" || parsed.contextWindow <= 0) return null;
    if (typeof parsed.fetchedAt !== "string") return null;
    const fetchedMs = Date.parse(parsed.fetchedAt);
    if (!Number.isFinite(fetchedMs) || nowMs - fetchedMs > CONTEXT_WINDOW_CACHE_TTL_MS) {
      return null;
    }
    return parsed.contextWindow;
  } catch {
    return null;
  }
}

/** Persist the context window to disk (atomic temp+rename). Fail-open. */
export async function writeCachedContextWindow(
  projectDir: string,
  modelId: string,
  contextWindow: number,
): Promise<void> {
  const file = contextWindowPath(projectDir);
  try {
    await mkdir(join(projectDir, ".golem", "state"), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const payload: CachedWindow = {
      modelId,
      contextWindow,
      fetchedAt: new Date().toISOString(),
    };
    await writeFile(tmp, `${JSON.stringify(payload)}\n`, "utf8");
    await rename(tmp, file);
  } catch {
    // fail-open — the caller will just skip the check
  }
}

/** Build the `/v1/models` URL from a base URL, tolerating a trailing `/v1`. */
function modelsUrl(baseUrl: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
}

/**
 * OpenRouter's `/v1/models` returns entries like:
 *   { "id": "openai/gpt-oss-20b:free", "context_windows": [131072] }
 * Some providers use `context_window` (singular) or `max_tokens`.
 */
function parseContextWindowFromModels(body: unknown, modelId: string): number | null {
  if (!isRecord(body) || !Array.isArray(body.data)) return null;
  for (const entry of body.data) {
    if (!isRecord(entry) || entry.id !== modelId) continue;
    // OpenRouter: context_windows is an array of ints
    if (Array.isArray(entry.context_windows)) {
      const first = entry.context_windows[0];
      if (typeof first === "number" && Number.isInteger(first) && first > 0) {
        return first;
      }
    }
    // Singular form (some providers)
    const cw = entry.context_window;
    if (typeof cw === "number" && Number.isInteger(cw) && cw > 0) return cw;
    // OpenRouter uses `context_length`
    const cl = entry.context_length;
    if (typeof cl === "number" && Number.isInteger(cl) && cl > 0) return cl;
    // max_tokens (some OpenAI-compatible servers)
    const mt = entry.max_tokens;
    if (typeof mt === "number" && Number.isInteger(mt) && mt > 0) return mt;
  }
  return null;
}

/** Fetch the context window for a specific model from an OpenAI-compatible `/v1/models`. */
export async function fetchContextWindow(
  baseUrl: string,
  modelId: string,
  apiKey: string | undefined,
  timeoutMs: number = 5000,
): Promise<number | null> {
  const url = modelsUrl(baseUrl);
  try {
    const res = await request(url, {
      method: "GET",
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      headers: apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      await res.body.dump();
      return null;
    }
    const body = (await res.body.json()) as unknown;
    return parseContextWindowFromModels(body, modelId);
  } catch {
    return null;
  }
}

/**
 * Estimate the token count of a request body.
 * Uses the same heuristic as the compression stage (~4 chars/token).
 */
export function estimateRequestBodyTokens(body: Buffer | null): number {
  if (body === null || body.length === 0) return 0;
  return estimateTokens(body.toString("utf8"));
}

/**
 * Anthropic-style error body returned when the upstream's context window would be exceeded.
 * This simulates the error the real Anthropic API returns, prompting Claude Code to
 * compact/truncate the conversation.
 */
export const CONTEXT_LENGTH_EXCEEDED_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "context_length_exceeded",
    message:
      "This model's maximum context length has been exceeded. " +
      "Claude Code will attempt to compact or truncate the conversation to fit.",
  },
});

interface ContextWindowCheck {
  /**
   * Returns true if the request should be rejected with a simulated
   * context_length_exceeded error.
   *
   * Returns false (proceed normally) when:
   * - the upstream model's context window is unknown (fail-open)
   * - the estimated request size is within the threshold
   */
  shouldReject: (requestBody: Buffer | null) => boolean;
  /** The upstream context window in tokens, or null if unknown. */
  readonly contextWindow: number | null;
  /** The estimated request token count from the last `shouldReject` call. */
  readonly estimatedTokens: number;
}

/**
 * Build a context-window gate for a translating provider.
 *
 * The gate is fail-open: if the context window cannot be determined, it never rejects.
 * Only applies to POST /v1/messages (the chat endpoint), not other paths or
 * byte-faithful Anthropic passthrough upstreams (where the window is Claude's own
 * ~200K and Claude Code already tracks it correctly).
 *
 * @param projectDir — for cache file location
 * @param upstreamModel — the configured OpenRouter/OpenAI model id (e.g. `poolside/laguna-s-2.1:free`)
 * @param upstreamBaseUrl — the upstream base URL
 * @param upstreamApiKey — optional API key for authenticated model-list fetches
 */
export async function buildContextWindowCheck(
  projectDir: string,
  upstreamModel: string | undefined,
  upstreamBaseUrl: string,
  upstreamApiKey: string | undefined,
): Promise<ContextWindowCheck> {
  if (upstreamModel === undefined) {
    return {
      shouldReject: () => false,
      contextWindow: null,
      estimatedTokens: 0,
    };
  }

  // Try cache first
  let window: number | null = await readCachedContextWindow(projectDir, upstreamModel);

  if (window === null) {
    // Cache miss — fetch from upstream
    window = await fetchContextWindow(upstreamBaseUrl, upstreamModel, upstreamApiKey);
    if (window !== null) {
      void writeCachedContextWindow(projectDir, upstreamModel, window);
    }
  }

  if (window === null) {
    // Unknown window — fail open
    return {
      shouldReject: () => false,
      contextWindow: null,
      estimatedTokens: 0,
    };
  }

  return {
    contextWindow: window,
    estimatedTokens: 0,
    shouldReject: (requestBody: Buffer | null) => {
      const estimated = estimateRequestBodyTokens(requestBody);
      // Leave 10% headroom for the response + overhead
      const threshold = Math.floor(window * 0.9);
      return estimated > threshold;
    },
  };
}
