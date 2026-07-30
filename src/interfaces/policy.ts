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

/**
 * Output-side brevity level (Decision 52). Distinct in kind from every other
 * field here: the compression stages transform the request payload, whereas
 * brevity appends a fixed directive to the `system` block and the MODEL complies
 * at generation time. It therefore saves **output** tokens and costs a small
 * number of input tokens — the inverse of Decision 23's economics, which is the
 * whole reason it exists (verification-notes §87).
 *
 * `wenyan` (Caveman's classical-Chinese level) is deliberately absent: it
 * changes the response language, which breaks readability and any downstream
 * parsing. Do not add it without a new Decisions Log entry.
 */
export type BrevityLevel = "off" | "lite" | "full" | "ultra";

export const BrevityLevel = {
  Off: "off",
  Lite: "lite",
  Full: "full",
  Ultra: "ultra",
} as const satisfies Record<string, BrevityLevel>;

/** Every brevity level, weakest first — the display/CLI ordering. */
export const BREVITY_LEVELS: readonly BrevityLevel[] = Object.freeze([
  "off",
  "lite",
  "full",
  "ultra",
] as const);

/**
 * A dial that either follows the slider preset (`"auto"`) or is pinned to an
 * explicit value (Decision 52, USER DECISION: **a pin wins and sticks** — the
 * slider stops driving a dial once it is pinned, until it is set back to
 * `"auto"`). Surfaces must render which of the two is in force; a pinned dial
 * that silently looked like a preset would be worse than no pin at all.
 */
export type Pinned<T> = "auto" | T;
export type BrevityDial = Pinned<BrevityLevel>;
export type CompressionDial = Pinned<SliderLevel>;

/**
 * Slider level → default brevity, the "sensible defaults" half of Decision 52.
 *
 * Brevity is **off at levels 0 and 1**, and that is a USER DECISION with a
 * reason worth keeping: level 1 is sold as *semantics-preserving*. Compression
 * at level 1 changes bytes without changing meaning; a brevity directive changes
 * what the model *says*, which every user notices immediately. The default
 * install must never start answering in fragments. `ultra` is never a preset —
 * it is reachable only by an explicit pin.
 */
const BREVITY_PRESET: Readonly<Record<SliderLevel, BrevityLevel>> = Object.freeze({
  0: "off", // passthrough: nothing runs at all (Decision 30)
  1: "off", // lossless: semantics-preserving, so output style is untouched
  2: "lite",
  3: "full",
});

export function brevityPresetForLevel(level: SliderLevel): BrevityLevel {
  return BREVITY_PRESET[level];
}

/**
 * Lowest compression level the dial may select while the slider is active.
 *
 * This is a **safety clamp, not a preference**: `LEVEL_TABLE[0]` is the
 * Decision-30 passthrough, the one place where `redaction` is false. If a pinned
 * `compression.level` of 0 were honoured at slider ≥1 it would silently disable
 * redaction — a CLAUDE.md hard-rule violation reachable from a config file. So a
 * pinned 0 clamps to 1, and redaction-off remains reachable **only** by moving
 * the slider itself to 0, where it is surfaced loudly.
 */
export const MIN_ACTIVE_COMPRESSION_LEVEL: SliderLevel = 1;

/**
 * Effective compression level: which {@link StageConfig} row actually runs.
 *
 * Passthrough is absolute — at slider 0 no pin can re-enable a stage, because
 * level 0 means "Golem does nothing" (Decision 30) and a dial that could
 * partially undo that would make the bypass a lie.
 */
export function resolveCompressionLevel(
  sliderLevel: SliderLevel,
  pin: CompressionDial = "auto",
): SliderLevel {
  if (sliderLevel === SliderLevel.Passthrough) return SliderLevel.Passthrough;
  if (pin === "auto") return sliderLevel;
  return pin < MIN_ACTIVE_COMPRESSION_LEVEL ? MIN_ACTIVE_COMPRESSION_LEVEL : pin;
}

/** Effective brevity level. Passthrough forces `off` for the same reason. */
export function resolveBrevity(sliderLevel: SliderLevel, pin: BrevityDial = "auto"): BrevityLevel {
  if (sliderLevel === SliderLevel.Passthrough) return BrevityLevel.Off;
  return pin === "auto" ? brevityPresetForLevel(sliderLevel) : pin;
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
  // via the explicit `coder` MCP tool, never auto-triggered by the slider.
  3: Object.freeze({
    redaction: true,
    losslessCompression: true,
    toolResultCache: true,
    semanticCompression: "aggressive",
    semanticCache: "loose",
  } as const),
});

/**
 * A resolved policy for one request: level + stages + brevity + per-capability
 * overrides.
 *
 * Since Decision 52 the slider is a **preset over two independent dials**, so
 * three level-ish fields coexist and mean different things:
 *
 * - {@link level} — the *slider* level. The request's identity for telemetry
 *   bucketing and for every display, unchanged from before.
 * - {@link compressionLevel} — the *effective* compression level, which selects
 *   {@link stages}. Equals `level` unless `compression.level` is pinned.
 * - {@link brevity} — the effective output-side brevity level.
 *
 * `overrides` carries per-capability overrides from settings (snake_case keys,
 * e.g. `{"semantic_cache": "off"}`); interpretation belongs to the consuming
 * stage, not this contract. The two dials are deliberately NOT overrides: they
 * are first-class, typed, and every stage/display must see them.
 */
export interface SliderPolicy {
  readonly level: SliderLevel;
  readonly compressionLevel: SliderLevel;
  readonly brevity: BrevityLevel;
  readonly stages: StageConfig;
  readonly overrides: Readonly<Record<string, unknown>>;
}

/**
 * Resolve a policy from the slider level plus optional per-dial pins.
 *
 * **`brevity` defaults to `"off"`, NOT `"auto"`.** Two reasons, both deliberate:
 * a caller that predates Decision 52 must not silently acquire a new
 * output-mutating behaviour just by omitting an argument; and Decision 52 ships
 * the dial off until the telemetry rollup proves it pays. `"auto"` is the value
 * that opts into the preset table, and the settings layer passes it through
 * explicitly. `compression` defaults to `"auto"` because tracking the slider IS
 * its pre-Decision-52 behaviour.
 */
export function sliderPolicyForLevel(
  level: SliderLevel,
  opts: {
    readonly overrides?: Readonly<Record<string, unknown>>;
    readonly brevity?: BrevityDial;
    readonly compression?: CompressionDial;
  } = {},
): SliderPolicy {
  const compressionLevel = resolveCompressionLevel(level, opts.compression ?? "auto");
  return Object.freeze({
    level,
    compressionLevel,
    brevity: resolveBrevity(level, opts.brevity ?? BrevityLevel.Off),
    stages: LEVEL_TABLE[compressionLevel],
    overrides: Object.freeze({ ...(opts.overrides ?? {}) }),
  });
}
