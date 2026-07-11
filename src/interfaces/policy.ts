/**
 * SliderPolicy — FROZEN CONTRACT (IMPLEMENTATION_PLAN §2.4).
 *
 * Maps the global quality/savings slider (0–3) to per-stage configuration.
 * Changing anything here requires updating tests/contract/policy.contract.test.ts
 * and flagging every workstream in the PR description (CLAUDE.md hard rule).
 */

/**
 * Global quality/savings level (spec §4, simplified to four levels by
 * Decision 30, 2026-07-11):
 *
 * - 0 `passthrough` — Golem does NOTHING, not even redaction (Decision 30, USER
 *                 decision): a deliberate, byte-faithful full bypass. The ONLY
 *                 level where the redaction hard rule does not apply. Never the
 *                 default; surfaced loudly wherever it is active because secrets
 *                 reach the upstream raw.
 * - 1 `lossless`  — redaction + lossless dedup/compaction/cache-align. Byte-faithful.
 * - 2 `balanced`  — + lossy semantic compression (stale-turn drop) + semantic cache.
 * - 3 `aggressive`— + max semantic + local drafts + local-first answers (opt-in).
 *
 * New-table design vs the old 0–5 scale: the new table folds old 1+2 into
 * `lossless` (they were identical in the live path — `toolResultCache` was
 * never wired) and old 4+5 into `aggressive` (they differed only by
 * `localOnlyAnswers`, itself gated by `local_only_opt_in`).
 *
 * On-disk MIGRATION is necessarily clamp-based, not a lossless remap: old and
 * new scales share integers with different meanings (old 3 = balanced, new 3 =
 * aggressive), and {@link migrateSliderLevel} runs on every read, so it MUST be
 * idempotent. It therefore takes 0–3 at face value and only clamps the
 * unambiguously-legacy 4/5 down to 3. The two real configs migrate correctly
 * (default 1 → 1; a dogfooding 5 → 3); a stored old 2/3 adopts the new meaning
 * of that number (re-set the slider if that matters).
 */
export type SliderLevel = 0 | 1 | 2 | 3;

export const SliderLevel = {
  Passthrough: 0,
  Lossless: 1,
  Balanced: 2,
  Aggressive: 3,
} as const satisfies Record<string, SliderLevel>;

/** Highest valid slider level. */
export const MAX_SLIDER_LEVEL: SliderLevel = 3;

/**
 * Clamp any value onto the current 0–3 scale (Decision 30). Values 0–3 pass
 * through unchanged (so this is idempotent and safe on every read); legacy 4/5
 * — impossible on the new scale — clamp to 3 (aggressive); out-of-range/junk
 * clamps into range rather than throwing, so a stale settings number never
 * crashes the loader.
 */
export function migrateSliderLevel(value: number): SliderLevel {
  const n = Math.round(value);
  if (n <= 0) return 0;
  if (n >= 3) return 3; // 3 (aggressive) and legacy 4/5 all resolve to the top
  return n as SliderLevel; // 1 or 2, unchanged
}

/** How aggressively local models summarize context (slider >= 3). */
export type SemanticCompression = "off" | "stale_turns" | "low_relevance" | "aggressive";

/** Semantic query-cache threshold mode. Never applies to tool-use requests (spec §8). */
export type SemanticCache = "off" | "strict" | "normal" | "loose";

/**
 * Per-stage switches derived from a slider level.
 *
 * `redaction` is true at every level EXCEPT level 0 ("passthrough"), and when
 * true it always runs first — before any content is transformed, stored, or
 * forwarded (CLAUDE.md hard rule). Level 0 is the one deliberate exception
 * (Decision 30, USER decision): a full bypass where nothing — including
 * redaction — runs.
 */
export interface StageConfig {
  readonly redaction: boolean;
  readonly losslessCompression: boolean;
  readonly toolResultCache: boolean;
  readonly semanticCompression: SemanticCompression;
  readonly semanticCache: SemanticCache;
}

const LEVEL_TABLE: Readonly<Record<SliderLevel, StageConfig>> = Object.freeze({
  // 0 "passthrough": deliberate byte-faithful full bypass — redaction included
  // in what is bypassed (Decision 30).
  0: Object.freeze({
    redaction: false,
    losslessCompression: false,
    toolResultCache: false,
    semanticCompression: "off",
    semanticCache: "off",
  } as const),
  // 1 "lossless": redaction + byte-faithful lossless compression.
  1: Object.freeze({
    redaction: true,
    losslessCompression: true,
    toolResultCache: false,
    semanticCompression: "off",
    semanticCache: "off",
  } as const),
  // 2 "balanced": + lossy semantic compression (stale-turn drop) + semantic cache.
  2: Object.freeze({
    redaction: true,
    losslessCompression: true,
    toolResultCache: true,
    semanticCompression: "stale_turns",
    semanticCache: "strict",
  } as const),
  // 3 "aggressive": + max semantic compression + loose semantic cache. Purely a
  // Headroom-aggressiveness dial (Decision 31) — the local model is invoked only
  // via the explicit `delegate` MCP tool, never auto-triggered by the slider.
  3: Object.freeze({
    redaction: true,
    losslessCompression: true,
    toolResultCache: true,
    semanticCompression: "aggressive",
    semanticCache: "loose",
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
  readonly overrides: Readonly<Record<string, unknown>>;
}

export function sliderPolicyForLevel(
  level: SliderLevel,
  opts: {
    readonly overrides?: Readonly<Record<string, unknown>>;
  } = {},
): SliderPolicy {
  return Object.freeze({
    level,
    stages: LEVEL_TABLE[level],
    overrides: Object.freeze({ ...(opts.overrides ?? {}) }),
  });
}
