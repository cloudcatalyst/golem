/**
 * PipelinePolicy — FROZEN CONTRACT (IMPLEMENTATION_PLAN §2.4).
 *
 * Maps the compression dial to per-stage configuration. Changing anything here
 * requires updating tests/contract/policy.contract.test.ts and flagging every
 * workstream in the PR description (CLAUDE.md hard rule).
 *
 * **R11.1 / ADR-0004 retired the slider.** There is no longer a global 0–3
 * "quality/savings" level that presets these dials: `compression.level` and
 * `brevity.level` are set directly, because a preset over two dials meant two
 * controls described one thing and every surface had to render both or mislead.
 * The `auto` state and the preset table went with it.
 */

/**
 * How much of the request pipeline runs.
 *
 * - `off` — redaction ONLY. Nothing else touches the request.
 * - `1` — + lossless dedup/compaction/cache-align. Byte-faithful.
 * - `2` — + lossy semantic compression (stale-turn drop) + semantic cache.
 * - `3` — + max semantic compression + loose semantic cache.
 *
 * **There is deliberately no level that disables redaction** (ADR-0004). The old
 * scale's level 0 was a full bypass, redaction included, so one integer in a
 * settings file could switch redaction off — and `MIN_ACTIVE_COMPRESSION_LEVEL`
 * existed only to stop a *pinned* dial doing the same thing by accident. That
 * bypass now lives in `proxy.bypass_all`, an explicit CLI-only setting, which
 * short-circuits before this table is ever consulted. Every row below therefore
 * has `redaction: true`, which makes "a dial turned redaction off" not merely
 * guarded against but unrepresentable.
 *
 * Levels 2 and 3 are still gated OFF on a prompt-caching upstream (Decision 31),
 * so the level that RAN can differ from the level that was SET — see
 * `resolveEffectiveCompression` (§103). That discrepancy is real and stays
 * visible; retiring the slider removed the needless one.
 */
export type CompressionLevel = "off" | 1 | 2 | 3;

export const CompressionLevel = {
  Off: "off",
  Lossless: 1,
  Balanced: 2,
  Aggressive: 3,
} as const satisfies Record<string, CompressionLevel>;

/** Every compression level, weakest first — the display/CLI ordering. */
export const COMPRESSION_LEVELS: readonly CompressionLevel[] = Object.freeze([
  "off",
  1,
  2,
  3,
] as const);

/** The human name for a compression level, as every surface spells it. */
const COMPRESSION_NAMES: Readonly<Record<string, string>> = Object.freeze({
  off: "off",
  1: "lossless",
  2: "balanced",
  3: "aggressive",
});

export function compressionName(level: CompressionLevel): string {
  return COMPRESSION_NAMES[String(level)] ?? String(level);
}

/**
 * Coerce a stored/typed-in value onto the current scale. Runs on every read, so
 * it MUST be idempotent.
 *
 * R11.1: `0` no longer means "bypass everything" — that moved to
 * `proxy.bypass_all` — so a stored 0 resolves to `off` (redaction only), which
 * is the safe half of what it used to mean. The migration in
 * `src/config/migrations.ts` is what turns a genuine level-0 install into
 * `bypass_all`, once, with the change surfaced; this function is the last-resort
 * clamp for anything that reaches the loader unmigrated, and it fails toward
 * MORE protection rather than less. Legacy 4/5 clamp to 3 as they always did.
 */
export function coerceCompressionLevel(value: unknown): CompressionLevel {
  if (value === "off") return "off";
  const n = typeof value === "number" ? Math.round(value) : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return 1;
  if (n <= 0) return "off";
  if (n >= 3) return 3;
  return n as CompressionLevel;
}

/**
 * Output-side brevity level (Decision 52). Distinct in kind from compression:
 * the compression stages transform the request payload, whereas brevity appends
 * a fixed directive to the `system` block and the MODEL complies at generation
 * time. It therefore saves **output** tokens and costs a small number of input
 * tokens — the inverse of Decision 23's economics, which is the whole reason it
 * exists (verification-notes §87).
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

/** How aggressively local models summarize context (compression level 3). */
export type SemanticCompression = "off" | "stale_turns" | "low_relevance" | "aggressive";

/** Semantic query-cache threshold mode. Never applies to tool-use requests (spec §8). */
export type SemanticCache = "off" | "strict" | "normal" | "loose";

/**
 * Per-stage switches derived from a compression level.
 *
 * `redaction` is true in EVERY row, and when true it always runs first — before
 * any content is transformed, stored, or forwarded (CLAUDE.md hard rule). The
 * one deliberate exception to redaction is `proxy.bypass_all` (ADR-0004), which
 * bypasses the pipeline entirely and never reaches this table.
 */
export interface StageConfig {
  readonly redaction: boolean;
  readonly losslessCompression: boolean;
  readonly toolResultCache: boolean;
  readonly semanticCompression: SemanticCompression;
  readonly semanticCache: SemanticCache;
}

const LEVEL_TABLE: Readonly<Record<string, StageConfig>> = Object.freeze({
  // "off": redaction and nothing else. Nameable for the first time in R11.1 —
  // before that it existed only as an accident of the Decision 56 bypass shim,
  // reachable by stopping the proxy rather than by asking for it.
  off: Object.freeze({
    redaction: true,
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
  // via the explicit `coder` MCP tool, never auto-triggered by a dial.
  3: Object.freeze({
    redaction: true,
    losslessCompression: true,
    toolResultCache: true,
    semanticCompression: "aggressive",
    semanticCache: "loose",
  } as const),
});

/**
 * The numeric rank of a compression level, for telemetry bucketing and ordering.
 *
 * `off` ranks 0. That collides with a PRE-R11.1 telemetry row, where 0 meant the
 * old level-0 full bypass (no redaction either) — deliberately, and only here:
 * for the savings metric these rows carry, both mean "no compression ran", so the
 * bucket's meaning is stable even though the configuration behind it changed. No
 * stored row is rewritten or relabelled (ADR-0004); `golem stats` renders rank 0
 * as "off".
 */
export function compressionRank(level: CompressionLevel): number {
  return level === "off" ? 0 : level;
}

/** The stage row for a compression level. */
export function stagesForCompression(level: CompressionLevel): StageConfig {
  return LEVEL_TABLE[String(level)] as StageConfig;
}

/**
 * A resolved policy for one request: the two dials plus the stage row they
 * select, and per-capability overrides.
 *
 * R11.1 removed the third level-ish field. There used to be `level` (the slider)
 * AND `compressionLevel` (what actually ran), which differed whenever a dial was
 * pinned — two numbers on one object, one of which every display had to know not
 * to trust. `compression` is now the only one.
 *
 * `overrides` carries per-capability overrides from settings (snake_case keys,
 * e.g. `{"semantic_cache": "off"}`); interpretation belongs to the consuming
 * stage, not this contract. The dials are deliberately NOT overrides: they are
 * first-class, typed, and every stage/display must see them.
 */
export interface PipelinePolicy {
  readonly compression: CompressionLevel;
  readonly brevity: BrevityLevel;
  readonly stages: StageConfig;
  readonly overrides: Readonly<Record<string, unknown>>;
}

/**
 * Resolve a policy from the two dials.
 *
 * Both default to `off` — the least surprising thing a caller that omits an
 * argument can get, and for brevity the same reasoning Decision 52 gave: a
 * caller must not silently acquire an output-mutating behaviour by leaving an
 * argument out.
 */
export function policyFor(
  compression: CompressionLevel = "off",
  opts: {
    readonly overrides?: Readonly<Record<string, unknown>>;
    readonly brevity?: BrevityLevel;
  } = {},
): PipelinePolicy {
  return Object.freeze({
    compression,
    brevity: opts.brevity ?? BrevityLevel.Off,
    stages: stagesForCompression(compression),
    overrides: Object.freeze({ ...(opts.overrides ?? {}) }),
  });
}
