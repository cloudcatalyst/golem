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
import { chatModelFor, embedModelFor } from "./catalog.js";
import {
  type ChatCompletion,
  InferenceEndpointError,
  ModelNotAvailableError,
  type OllamaClient,
} from "./ollama-client.js";

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
}

/** InferenceService backed by an Ollama-compatible endpoint. */
export class OllamaInferenceService implements InferenceService {
  readonly #client: OllamaClient;
  readonly #tier: HardwareTier;
  readonly #stepDownTier: boolean;
  readonly #allowHaiku: boolean;

  constructor(client: OllamaClient, facts: CapabilityFacts, options: OllamaInferenceOptions = {}) {
    this.#client = client;
    this.#tier = facts.tier;
    this.#stepDownTier = options.fallback?.stepDownTier ?? true;
    this.#allowHaiku = options.fallback?.allowHaiku ?? false;
  }

  capabilities(): HardwareTier {
    return this.#tier;
  }

  async chat(
    modelRole: Role,
    messages: readonly ChatMessage[],
    opts?: ChatOptions,
  ): Promise<ChatResult> {
    // Try this tier, then step down toward P_CPU (0) if permitted.
    const lowest = this.#stepDownTier ? 0 : this.#tier;
    for (let tier = this.#tier; tier >= lowest; tier -= 1) {
      const model = chatModelFor(tier as HardwareTier, modelRole);
      let completion: ChatCompletion;
      try {
        completion = await this.#client.chat({
          model,
          messages,
          ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(opts?.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
          ...(opts?.jsonSchema !== undefined ? { jsonSchema: opts.jsonSchema } : {}),
          ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
        });
      } catch (err) {
        // A missing model → try the next lower tier. Any other endpoint error
        // is terminal for the local path (don't hammer a broken endpoint).
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
    throw new CapabilityUnavailableError(modelRole, this.#tier);
  }

  async embed(texts: readonly string[], kind: "text" | "code"): Promise<Vector[]> {
    const model = embedModelFor(this.#tier, kind);
    return this.#client.embed(model, texts);
  }
}
