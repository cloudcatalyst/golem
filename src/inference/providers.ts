/**
 * R8.15 — the local-model provider table and resolution.
 *
 * `settings.inference.providers` lets a user declare which upstream provider
 * the `coder`/`drafter` role routes to when the local Ollama is not the backend
 * — e.g. pointing `coder` at a llama.cpp server, an OpenAI-compatible endpoint,
 * or an Anthropic-native gateway. When absent, the tier catalog default + Ollama
 * probe path is used (the pre-R8.15 behaviour).
 *
 * Each `ProviderEntry` is NON-SECRET: id, api, base_url, and a models list with
 * per-model role assignments. The credential (if any) is resolved from the OS
 * credential store by the proxy at spawn, never stored here.
 */

import type { HardwareTier, Role } from "../interfaces/inference.js";
import { chatModelFor } from "./catalog.js";

/**
 * API shapes a provider entry can declare. The `api` field selects which
 * probe path and request format the resolver uses:
 * - `"openai-completions"` → OpenAI-compatible Chat Completions at `/v1/chat/completions`.
 * - `"openai-embeddings"` → OpenAI-compatible embeddings at `/v1/embeddings`.
 * - `"openai"` → generic OpenAI-compatible at `/v1/models` (probe only).
 * - `"ollama"` → Ollama native at `/api/tags`.
 * - `"anthropic"` → Anthropic Messages at `/v1/messages`.
 */
export type ProbeApi =
  | "openai-completions"
  | "openai-embeddings"
  | "openai"
  | "ollama"
  | "anthropic";

/**
 * One model entry under a provider's `models` list.
 */
export interface ProviderModelEntry {
  /** The model id as the upstream knows it. */
  readonly id: string;
  /** Roles this model covers (default `["drafter"]`). */
  readonly roles?: readonly Role[];
  /** The upstream's context window for this model, in tokens. */
  readonly context_window?: number;
}

/** One provider entry in `settings.inference.providers`. */
export interface ProviderEntry {
  /** Unique key within the user's provider set. */
  readonly id: string;
  /** Which API shape this endpoint speaks. */
  readonly api: ProbeApi;
  /** Full base URL including protocol and port, no trailing path. */
  readonly base_url: string;
  /** The models this endpoint serves, each with its role coverage. */
  readonly models: readonly ProviderModelEntry[];
}

/** What `resolveChatModel` returns — the concrete model + where to reach it. */
export interface ResolvedChatModel {
  /** The model id the role should use at this provider. */
  readonly model: string;
  /** The base URL to probe / send to. */
  readonly baseUrl: string;
  /** Which probe shape applies to `baseUrl`. */
  readonly api: ProbeApi;
  /** The upstream context window for this model, if declared. */
  readonly contextWindow?: number;
}

/**
 * Resolve which provider + model a role (`"drafter"`, `"judge"`) should use,
 * given the user's provider table and the local hardware tier.
 *
 * Selection: the first provider entry that has a model covering `role` wins
 * (stable array order = user intent). If no entry covers `role`, fall back to
 * the tier catalog default and the supplied `ollamaBaseUrl` + `"ollama"` api.
 */
export function resolveChatModel(
  role: Role,
  opts: {
    readonly providers: readonly ProviderEntry[];
    readonly tier: HardwareTier;
    readonly ollamaBaseUrl: string;
  },
): ResolvedChatModel {
  for (const provider of opts.providers) {
    for (const model of provider.models) {
      if ((model.roles ?? ["drafter"]).includes(role)) {
        return {
          model: model.id,
          baseUrl: provider.base_url,
          api: provider.api,
          ...(model.context_window !== undefined ? { contextWindow: model.context_window } : {}),
        };
      }
    }
  }
  // No provider covers this role — fall back to local Ollama + tier catalog.
  return {
    model: chatModelFor(opts.tier, role),
    baseUrl: opts.ollamaBaseUrl,
    api: "ollama",
  };
}

/**
 * Bounded, never-throwing reachability probe for an inference endpoint.
 *
 * Dispatches on `api`:
 * - `"ollama"` → GET `/api/tags` (Ollama native).
 * - `"openai"` / `"openai-completions"` / `"openai-embeddings"` → GET `/v1/models`.
 * - `"anthropic"` → HEAD `/v1/messages` (just checks the socket answers with
 *   200/401, never 404s on auth).
 *
 * The default 800ms budget matches `probeLocalModel` so a provider-backed status
 * check never blocks the per-turn status line.
 */
export async function probeInferenceEndpoint(
  baseUrl: string,
  api: ProbeApi,
  timeoutMs = 800,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const origin = baseUrl.replace(/\/+$/, "");
    const path =
      api === "ollama" ? "/api/tags" : api === "anthropic" ? "/v1/messages" : "/v1/models";
    const url = `${origin}${path}`;
    const method = api === "anthropic" ? "HEAD" : "GET";
    const res = await fetch(url, { signal: controller.signal, method });
    if (!res.ok) return false;
    if (api === "anthropic") return true; // HEAD — body is irrelevant.
    const body = (await res.json()) as { models?: unknown } | undefined;
    if (body === undefined || body === null) return true; // empty 200 = up
    return Array.isArray(body.models) && body.models.length > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
