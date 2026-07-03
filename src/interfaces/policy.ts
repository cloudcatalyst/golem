/**
 * SliderPolicy — FROZEN CONTRACT (IMPLEMENTATION_PLAN §2.4).
 *
 * Maps the global quality/savings slider (0–5) to per-stage configuration.
 * Changing anything here requires updating tests/contract/policy.contract.test.ts
 * and flagging every workstream in the PR description (CLAUDE.md hard rule).
 */

/** Global quality/savings level (spec §4). */
export type SliderLevel = 0 | 1 | 2 | 3 | 4 | 5;

export const SliderLevel = {
  Passthrough: 0,
  Lossless: 1,
  Conservative: 2,
  Balanced: 3,
  Aggressive: 4,
  MaxSavings: 5,
} as const satisfies Record<string, SliderLevel>;

/** How aggressively local models summarize context (slider >= 3). */
export type SemanticCompression = "off" | "stale_turns" | "low_relevance" | "aggressive";

/** Semantic query-cache threshold mode. Never applies to tool-use requests (spec §8). */
export type SemanticCache = "off" | "strict" | "normal" | "loose";

/**
 * Per-stage switches derived from a slider level.
 *
 * `redaction` is true at EVERY level and always runs first — before any
 * content is transformed, stored, or forwarded (CLAUDE.md hard rule).
 */
export interface StageConfig {
  readonly redaction: boolean;
  readonly losslessCompression: boolean;
  readonly toolResultCache: boolean;
  readonly semanticCompression: SemanticCompression;
  readonly semanticCache: SemanticCache;
  readonly localDrafts: boolean;
  readonly localOnlyAnswers: boolean;
}

const LEVEL_TABLE: Readonly<Record<SliderLevel, StageConfig>> = Object.freeze({
  0: Object.freeze({
    redaction: true,
    losslessCompression: false,
    toolResultCache: false,
    semanticCompression: "off",
    semanticCache: "off",
    localDrafts: false,
    localOnlyAnswers: false,
  } as const),
  1: Object.freeze({
    redaction: true,
    losslessCompression: true,
    toolResultCache: false,
    semanticCompression: "off",
    semanticCache: "off",
    localDrafts: false,
    localOnlyAnswers: false,
  } as const),
  2: Object.freeze({
    redaction: true,
    losslessCompression: true,
    toolResultCache: true,
    semanticCompression: "off",
    semanticCache: "off",
    localDrafts: false,
    localOnlyAnswers: false,
  } as const),
  3: Object.freeze({
    redaction: true,
    losslessCompression: true,
    toolResultCache: true,
    semanticCompression: "stale_turns",
    semanticCache: "strict",
    localDrafts: false,
    localOnlyAnswers: false,
  } as const),
  4: Object.freeze({
    redaction: true,
    losslessCompression: true,
    toolResultCache: true,
    semanticCompression: "low_relevance",
    semanticCache: "normal",
    localDrafts: true,
    localOnlyAnswers: false,
  } as const),
  5: Object.freeze({
    redaction: true,
    losslessCompression: true,
    toolResultCache: true,
    semanticCompression: "aggressive",
    semanticCache: "loose",
    localDrafts: true,
    // Gated again by SliderPolicy.localOnlyOptIn — see effectiveStages().
    localOnlyAnswers: true,
  } as const),
});

/**
 * A resolved policy for one request: level + stages + per-capability overrides.
 *
 * `overrides` carries per-capability overrides from settings (snake_case keys,
 * e.g. `{"semantic_cache": "off"}`); interpretation belongs to the consuming
 * stage, not this contract.
 */
export interface SliderPolicy {
  readonly level: SliderLevel;
  readonly stages: StageConfig;
  /** Per-project opt-in for level-5 local-only answers (spec §9 decision 7). */
  readonly localOnlyOptIn: boolean;
  readonly overrides: Readonly<Record<string, unknown>>;
}

export function sliderPolicyForLevel(
  level: SliderLevel,
  opts: {
    readonly localOnlyOptIn?: boolean;
    readonly overrides?: Readonly<Record<string, unknown>>;
  } = {},
): SliderPolicy {
  return Object.freeze({
    level,
    stages: LEVEL_TABLE[level],
    localOnlyOptIn: opts.localOnlyOptIn ?? false,
    overrides: Object.freeze({ ...(opts.overrides ?? {}) }),
  });
}

/** Stages with `localOnlyAnswers` masked off unless the project opted in. */
export function effectiveStages(policy: SliderPolicy): StageConfig {
  if (policy.stages.localOnlyAnswers && !policy.localOnlyOptIn) {
    return Object.freeze({ ...policy.stages, localOnlyAnswers: false });
  }
  return policy.stages;
}
