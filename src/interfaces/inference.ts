/**
 * InferenceService — FROZEN CONTRACT (IMPLEMENTATION_PLAN §2.2).
 *
 * OpenAI-compatible chat + embeddings client with hardware-capability metadata.
 * Implemented by `src/inference/` (WS-D). Role→model mapping comes from the
 * WS-D model catalog, selected by the detected hardware tier; callers never
 * name concrete models.
 */

/** The local-model role a caller wants, not a concrete model. */
export type Role = "summarizer" | "extractor" | "classifier" | "drafter" | "judge";

export const ALL_ROLES: readonly Role[] = Object.freeze([
  "summarizer",
  "extractor",
  "classifier",
  "drafter",
  "judge",
]);

/** Detected capability tier (spec §1 hardware profiles / §2.2 job tiers). */
export type HardwareTier = 0 | 1 | 2 | 3;

export const HardwareTier = {
  PCpu: 0,
  PMin: 1,
  PMid: 2,
  PMax: 3,
} as const satisfies Record<string, HardwareTier>;

/** An OpenAI-compatible chat message (`{"role": ..., "content": ...}`). */
export type ChatMessage = Readonly<Record<string, unknown>>;

/** An embedding vector. */
export type Vector = readonly number[];

export interface ChatOptions {
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly jsonSchema?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

/** Result of one local chat completion. */
export interface ChatResult {
  readonly text: string;
  readonly model: string;
  readonly role: Role;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly finishReason: string;
}

/**
 * Thrown when no backend can serve the requested role at the current tier and
 * no fallback (lower tier / Haiku-via-API) is permitted by config.
 */
export class CapabilityUnavailableError extends Error {
  constructor(role: Role, tier: HardwareTier) {
    super(`no backend available for role "${role}" at hardware tier ${tier}`);
    this.name = "CapabilityUnavailableError";
  }
}

/** Tiered local inference (Ollama-first, OpenAI-compatible protocol). */
export interface InferenceService {
  /**
   * Route to the tier-appropriate model for `modelRole`.
   *
   * Must degrade gracefully: fall back one tier, or to Claude Haiku via API if
   * the user allows, else reject with CapabilityUnavailableError — never crash
   * the pipeline (spec §1 design rules).
   */
  chat(modelRole: Role, messages: readonly ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;

  embed(texts: readonly string[], kind: "text" | "code"): Promise<Vector[]>;

  capabilities(): HardwareTier;
}
