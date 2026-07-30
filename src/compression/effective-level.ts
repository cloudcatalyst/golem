/**
 * What the compression level ACTUALLY does, as opposed to what it is set to.
 *
 * Why this module exists: `golem status` reported `Slider: level 3 (aggressive)`
 * against Anthropic while the two stages that distinguish levels 2–3 from level 1
 * were both gated off, so the observed behaviour was level 1. The number was true
 * and the impression it gave was false — a user reasonably read "aggressive" as
 * "aggressive compression is running". Nothing was wrong with the pipeline; the
 * reporting was wrong.
 *
 * Levels 2 and 3 differ from level 1 by exactly two stages — the Headroom lossy
 * semantic stage and context substitution — and BOTH are gated off on a
 * prompt-caching upstream (Decision 31). verification-notes §103 measured the
 * consequence of lifting that gate: net **8.7×–11.3× more expensive** than not
 * compressing, because Headroom's `read_lifecycle` diverges from the original
 * history at message 6 of 4,631 and destroys the cached prefix. So on Anthropic,
 * levels 2 and 3 are level 1 — by design, and correctly.
 *
 * **`pipeline.ts` remains the enforcement point; this module only predicts it.**
 * The two must not drift: if the gate conditions in `runGolemPipeline` change,
 * change `resolveEffectiveCompression` in the same commit.
 * `tests/unit/compression/effective-level.test.ts` pins the prediction against
 * the gate's own truth table.
 */

import type { SliderLevel } from "../interfaces/policy.js";

/**
 * Whether the upstream is an Anthropic-style prompt-caching endpoint, where
 * rewriting mid-history content forfeits the cached prefix.
 *
 * Moved here from `pipeline.ts` so the CLI and the pipeline share one definition
 * rather than two that can disagree. **Both unknown cases answer `true`** — an
 * absent URL means the default upstream (Anthropic), and an unparseable one is
 * answered conservatively. Being wrong in the `true` direction costs some
 * unrealised compression; being wrong in the `false` direction rewrites history
 * against a cache and costs ~9× (§103). The asymmetry is the whole reason for the
 * default.
 */
export function isCachingUpstream(upstreamBaseUrl: string | undefined): boolean {
  if (upstreamBaseUrl === undefined) return true; // default upstream is Anthropic — assume caching
  try {
    return new URL(upstreamBaseUrl).host.toLowerCase().includes("anthropic.com");
  } catch {
    return true; // unparseable → be conservative (assume caching, skip lossy compression)
  }
}

/** Everything needed to predict what the configured level will actually do. */
export interface EffectiveCompressionInput {
  /** The configured (nominal) level — `slider.level`, or the pinned `compression.level`. */
  readonly level: SliderLevel;
  /** `proxy.upstream_base_url`; absent → the Anthropic default. */
  readonly upstreamBaseUrl?: string;
  /**
   * Explicit provider-derived override (`upstreamAssumesCaching`, R6.1 case (a)).
   * Wins over the URL heuristic when present, exactly as `effectiveCaching` does
   * in the pipeline.
   */
  readonly assumeCachingUpstream?: boolean;
  /** `compression.headroom_sidecar` — without it there is no semantic stage at all. */
  readonly headroomSidecar: boolean;
  /** `compression.force_semantic_on_caching` — the R2.6 research bypass. */
  readonly forceSemanticOnCaching: boolean;
}

/** The nominal level, what actually runs, and why they differ. */
export interface EffectiveCompression {
  /** What the user set. */
  readonly nominal: SliderLevel;
  /** What the pipeline will actually apply. */
  readonly effective: SliderLevel;
  /** `effective < nominal` — the level is not delivering what its name implies. */
  readonly degraded: boolean;
  /** One sentence naming the cause and the lever. Present only when degraded. */
  readonly reason?: string;
}

/**
 * Predict the level the pipeline will actually apply. Mirrors the two stage gates
 * in `runGolemPipeline` — see this module's header on keeping them in step.
 */
export function resolveEffectiveCompression(
  input: EffectiveCompressionInput,
): EffectiveCompression {
  const nominal = input.level;

  // Levels 0 (passthrough) and 1 (lossless) have no lossy stage to gate, so they
  // always deliver what they say.
  if (nominal <= 1) {
    return { nominal, effective: nominal, degraded: false };
  }

  const caching = input.assumeCachingUpstream ?? isCachingUpstream(input.upstreamBaseUrl);

  if (caching && !input.forceSemanticOnCaching) {
    return {
      nominal,
      effective: 1,
      degraded: true,
      reason:
        "the lossy semantic and context-substitution stages are off on a prompt-caching " +
        "upstream (Decision 31; measured ~9× more expensive if forced — §103), so this " +
        "behaves as level 1 (lossless)",
    };
  }

  // Non-caching (or the gate was forced) — the stages are allowed to run, but the
  // semantic stage still needs a sidecar to exist.
  if (!input.headroomSidecar) {
    return {
      nominal,
      effective: 1,
      degraded: true,
      reason:
        "the Headroom sidecar is disabled, so there is no semantic stage to run — " +
        "enable it with `golem config set compression.headroom_sidecar true`",
    };
  }

  return { nominal, effective: nominal, degraded: false };
}
