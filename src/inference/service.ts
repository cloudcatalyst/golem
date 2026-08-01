/**
 * WS-D D3 — the InferenceService: detection (D1) + catalog (D2) + Ollama client
 * (D2) with role routing and graceful degradation (frozen contract in
 * src/interfaces/inference.ts).
 *
 * Fallback ladder for chat(), per the contract's "never crash the pipeline"
 * rule: try the tier's model → if the model is missing on the endpoint, step
 * down one tier and retry (a smaller model is better than none) → if nothing
 * local works and Haiku fallback is enabled, signal that (the actual cloud call
 * is the caller's job — this service only routes local inference) → else reject
 * with CapabilityUnavailableError.
 */

import {
  CapabilityUnavailableError,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type HardwareTier,
  type InferenceService,
  type Role,
  type Vector,
} from "../interfaces/inference.js";
import type { CapabilityFacts } from "./capability.js";
import { chatModelFor } from "./catalog.js";
import {
  type ChatCompletion,
  type ChatCompletionParams,
  InferenceEndpointError,
  ModelNotAvailableError,
  OllamaClient,
} from "./ollama-client.js";
import {
  type ProviderEntry,
  type ResolutionContext,
  resolveChatModel,
  resolveEmbedModel,
} from "./providers.js";

/** What to do when no local model can serve a role. */
export interface FallbackPolicy {
  /** Allow stepping down to a lower tier's (smaller) model. Default true. */
  readonly stepDownTier?: boolean;
  /**
   * If no local model works, permit a Claude Haiku fallback via the API. This
   * service does NOT make the cloud call; it throws HaikuFallbackRequired so the
   * caller (which owns API credentials) can. Default false.
   */
  readonly allowHaiku?: boolean;
}

/**
 * Thrown by chat() when local inference cannot serve the role but the policy
 * permits a Claude Haiku fallback. Carries the routing context so the caller
 * can make the cloud request.
 */
export class HaikuFallbackRequired extends Error {
  constructor(
    readonly role: Role,
    readonly messages: readonly ChatMessage[],
    readonly opts: ChatOptions | undefined,
  ) {
    super(`local inference unavailable for role "${role}"; Haiku fallback permitted`);
    this.name = "HaikuFallbackRequired";
  }
}

export interface OllamaInferenceOptions {
  readonly fallback?: FallbackPolicy;
  /**
   * R8.15 — the user's own provider table (`inference.providers`). Absent or empty
   * means every role resolves from the hardware-tier catalog over the injected
   * client's endpoint, which is exactly the pre-R8.15 behaviour.
   */
  readonly providers?: readonly ProviderEntry[] | undefined;
  /**
   * How to obtain a client for a provider endpoint that is not the injected one.
   * Optional: without it the service creates and caches its own, which
   * {@link OllamaInferenceService.close} then owns. Supply it when the caller wants
   * to control pooling or timeouts per endpoint.
   */
  readonly clientFor?: (baseUrl: string) => OllamaClient;
}

/** InferenceService backed by an Ollama-compatible endpoint. */
export class OllamaInferenceService implements InferenceService {
  readonly #client: OllamaClient;
  readonly #tier: HardwareTier;
  readonly #stepDownTier: boolean;
  readonly #allowHaiku: boolean;
  readonly #providers: readonly ProviderEntry[] | undefined;
  readonly #clientFor: ((baseUrl: string) => OllamaClient) | undefined;
  /** Clients this service created itself, and is therefore responsible for closing. */
  readonly #owned = new Map<string, OllamaClient>();

  constructor(client: OllamaClient, facts: CapabilityFacts, options: OllamaInferenceOptions = {}) {
    this.#client = client;
    this.#tier = facts.tier;
    this.#stepDownTier = options.fallback?.stepDownTier ?? true;
    this.#allowHaiku = options.fallback?.allowHaiku ?? false;
    this.#providers = options.providers;
    this.#clientFor = options.clientFor;
  }

  capabilities(): HardwareTier {
    return this.#tier;
  }

  /** Close only the clients this service created; the injected one belongs to the caller. */
  async close(): Promise<void> {
    await Promise.all([...this.#owned.values()].map((c) => c.close()));
    this.#owned.clear();
  }

  /** The context every resolution needs, built from what this service was given. */
  #resolution(): ResolutionContext {
    return {
      providers: this.#providers,
      tier: this.#tier,
      ollamaBaseUrl: this.#client.origin,
    };
  }

  /**
   * The client for a resolved endpoint. The injected client is reused whenever the
   * origins match — a provider that simply names the same Ollama Golem was already
   * pointed at must not open a second pool.
   */
  #clientForUrl(baseUrl: string): OllamaClient {
    let origin: string;
    try {
      origin = new URL(baseUrl).origin;
    } catch {
      return this.#client;
    }
    if (origin === this.#client.origin) return this.#client;
    const existing = this.#owned.get(origin);
    if (existing !== undefined) return existing;
    const created = this.#clientFor?.(baseUrl) ?? new OllamaClient({ baseUrl });
    this.#owned.set(origin, created);
    return created;
  }

  async chat(
    modelRole: Role,
    messages: readonly ChatMessage[],
    opts?: ChatOptions,
  ): Promise<ChatResult> {
    // R8.15 — a role the user routed explicitly is tried first, at its own endpoint.
    // If it fails we still fall through to the tier ladder below rather than giving
    // up: the contract's rule is "never crash the pipeline", and `ChatResult.model`
    // reports whatever actually ran, so the substitution is visible rather than
    // silent (the R4.4 lesson).
    const routed = resolveChatModel(modelRole, this.#resolution());
    let routedError: unknown;
    if (routed.source === "provider") {
      try {
        const completion = await this.#clientForUrl(routed.baseUrl).chat({
          model: routed.model,
          messages,
          ...chatOverrides(opts),
        });
        return {
          text: completion.text,
          model: completion.model,
          role: modelRole,
          promptTokens: completion.promptTokens,
          completionTokens: completion.completionTokens,
          finishReason: completion.finishReason,
        };
      } catch (err) {
        routedError = err;
      }
    }

    // Try this tier, then step down toward P_CPU (0) if permitted.
    const lowest = this.#stepDownTier ? 0 : this.#tier;
    let lastError: unknown;
    for (let tier = this.#tier; tier >= lowest; tier -= 1) {
      const model = chatModelFor(tier as HardwareTier, modelRole);
      let completion: ChatCompletion;
      try {
        completion = await this.#client.chat({
          model,
          messages,
          ...chatOverrides(opts),
        });
      } catch (err) {
        // A missing model → try the next lower tier. Any other endpoint error
        // is terminal for the local path (don't hammer a broken endpoint) —
        // but keep it, since it's almost always more informative than "missing
        // model" (e.g. a timeout under GPU/VRAM contention, or a malformed
        // response) for whoever ends up reading CapabilityUnavailableError.
        lastError = err;
        if (err instanceof ModelNotAvailableError) continue;
        if (err instanceof InferenceEndpointError) break;
        throw err;
      }
      return {
        text: completion.text,
        model: completion.model,
        role: modelRole,
        promptTokens: completion.promptTokens,
        completionTokens: completion.completionTokens,
        finishReason: completion.finishReason,
      };
    }

    if (this.#allowHaiku) {
      throw new HaikuFallbackRequired(modelRole, messages, opts);
    }
    // A routed failure outranks the ladder's: the user configured that provider on
    // purpose, so "your llama.cpp server refused" is the actionable fact, while
    // "qwen2.5:14b is not pulled" is a symptom of a fallback they never asked for.
    throw new CapabilityUnavailableError(modelRole, this.#tier, routedError ?? lastError);
  }

  async embed(texts: readonly string[], kind: "text" | "code"): Promise<Vector[]> {
    // R8.15 — same shape as chat(), minus the tier ladder: there is no "step down"
    // for embeddings, because a different embedding model produces vectors in a
    // different space and silently mixing spaces corrupts the index rather than
    // degrading it.
    const routed = resolveEmbedModel(kind, this.#resolution());
    if (routed.source === "provider") {
      return this.#clientForUrl(routed.baseUrl).embed(routed.model, texts);
    }
    return this.#client.embed(routed.model, texts);
  }
}

/** The subset of {@link ChatOptions} that maps onto a client call, spread-safe. */
function chatOverrides(opts: ChatOptions | undefined): Partial<ChatCompletionParams> {
  return {
    ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts?.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    ...(opts?.jsonSchema !== undefined ? { jsonSchema: opts.jsonSchema } : {}),
    ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
  };
}
