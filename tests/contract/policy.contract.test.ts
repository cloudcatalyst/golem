/**
 * Contract tests for the frozen SliderPolicy level table (plan §2.4).
 *
 * These run today (policy.ts is pure data). If a change here is needed,
 * the interface is changing — flag all workstreams.
 *
 * Scale simplified to 0–3 by Decision 30 (2026-07-11): off / lossless /
 * balanced / aggressive. Local drafts / local-first removed from the slider by
 * Decision 31 — levels are now purely a compression-aggressiveness dial.
 */

import { describe, expect, it } from "vitest";
import {
  BREVITY_LEVELS,
  BrevityLevel,
  brevityPresetForLevel,
  MAX_SLIDER_LEVEL,
  MIN_ACTIVE_COMPRESSION_LEVEL,
  migrateSliderLevel,
  resolveBrevity,
  resolveCompressionLevel,
  SliderLevel,
  sliderPolicyForLevel,
} from "../../src/interfaces/policy.js";

const ALL_LEVELS = [0, 1, 2, 3] as const;

describe("SliderPolicy level table", () => {
  it("redaction is on at every level EXCEPT 0 (passthrough), a full bypass (Decision 30)", () => {
    expect(sliderPolicyForLevel(SliderLevel.Passthrough).stages.redaction).toBe(false);
    for (const level of [1, 2, 3] as const) {
      expect(sliderPolicyForLevel(level).stages.redaction).toBe(true);
    }
  });

  it("level 0 is passthrough — nothing runs, not even redaction", () => {
    const stages = sliderPolicyForLevel(SliderLevel.Passthrough).stages;
    expect(stages.redaction).toBe(false);
    expect(stages.losslessCompression).toBe(false);
    expect(stages.toolResultCache).toBe(false);
    expect(stages.semanticCompression).toBe("off");
    expect(stages.semanticCache).toBe("off");
  });

  it("level 1 is lossless only (byte-faithful)", () => {
    const stages = sliderPolicyForLevel(SliderLevel.Lossless).stages;
    expect(stages.redaction).toBe(true);
    expect(stages.losslessCompression).toBe(true);
    expect(stages.semanticCompression).toBe("off");
  });

  it("level 2 (balanced) adds stale-turn semantic compression + strict semantic cache", () => {
    const stages = sliderPolicyForLevel(SliderLevel.Balanced).stages;
    expect(stages.losslessCompression).toBe(true);
    expect(stages.semanticCompression).toBe("stale_turns");
    expect(stages.semanticCache).toBe("strict");
  });

  it("level 3 (aggressive) enables max semantic compression (no local drafts — Decision 31)", () => {
    const stages = sliderPolicyForLevel(SliderLevel.Aggressive).stages;
    expect(stages.semanticCompression).toBe("aggressive");
    expect(stages.semanticCache).toBe("loose");
    // The slider is a pure compression dial now — no local-model fields exist.
    expect("localDrafts" in stages).toBe(false);
    expect("localOnlyAnswers" in stages).toBe(false);
  });

  it("raising the slider never turns a savings stage off, above level 1 (monotonicity)", () => {
    // Redaction is intentionally NON-monotonic (off at 0, on at 1+), so the
    // monotonicity invariant covers the savings stages and starts at level 1.
    for (const level of [2, 3] as const) {
      const lower = sliderPolicyForLevel((level - 1) as SliderLevel).stages;
      const higher = sliderPolicyForLevel(level).stages;
      expect(Number(higher.losslessCompression)).toBeGreaterThanOrEqual(
        Number(lower.losslessCompression),
      );
      expect(Number(higher.toolResultCache)).toBeGreaterThanOrEqual(Number(lower.toolResultCache));
    }
  });

  it("MAX_SLIDER_LEVEL is 3 (aggressive)", () => {
    expect(MAX_SLIDER_LEVEL).toBe(3);
    expect(SliderLevel.Aggressive).toBe(3);
  });

  it("migrateSliderLevel clamps onto 0–3, idempotently (0–3 unchanged, legacy 4/5 → 3)", () => {
    // 0–3 pass through at face value; legacy 4/5 clamp to 3.
    expect([0, 1, 2, 3, 4, 5].map(migrateSliderLevel)).toEqual([0, 1, 2, 3, 3, 3]);
    // Already-current values are stable (idempotent — this runs on every read).
    for (const level of ALL_LEVELS) {
      expect(migrateSliderLevel(level)).toBe(level);
      expect(migrateSliderLevel(migrateSliderLevel(level))).toBe(level);
    }
    // Out-of-range/junk clamps into range rather than throwing.
    expect(migrateSliderLevel(99)).toBe(3);
    expect(migrateSliderLevel(-4)).toBe(0);
  });

  it("policies are frozen", () => {
    const policy = sliderPolicyForLevel(SliderLevel.Lossless);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.stages)).toBe(true);
    expect(Object.isFrozen(policy.overrides)).toBe(true);
  });
});

/**
 * Decision 52 — the slider became a PRESET over two independent dials
 * (`compression.level`, `brevity.level`). These are contract tests: the dial
 * semantics and, above all, the redaction safety clamp are load-bearing.
 */
describe("SliderPolicy dials (Decision 52)", () => {
  it("brevity presets: off at 0 and 1, lite at 2, full at 3 — ultra is never a preset", () => {
    expect(ALL_LEVELS.map(brevityPresetForLevel)).toEqual(["off", "off", "lite", "full"]);
    // `ultra` must be reachable only by an explicit pin, never implied.
    expect(ALL_LEVELS.map(brevityPresetForLevel)).not.toContain("ultra");
  });

  it("brevity is never implied at slider <=1 — level 1 stays semantics-preserving", () => {
    // The default install must not start answering in fragments (USER DECISION).
    expect(sliderPolicyForLevel(SliderLevel.Passthrough).brevity).toBe("off");
    expect(sliderPolicyForLevel(SliderLevel.Lossless).brevity).toBe("off");
  });

  it("BREVITY_LEVELS is weakest-first and frozen", () => {
    expect(BREVITY_LEVELS).toEqual(["off", "lite", "full", "ultra"]);
    expect(Object.isFrozen(BREVITY_LEVELS)).toBe(true);
  });

  it("an explicit pin wins over the preset and does not move with the slider", () => {
    for (const level of [1, 2, 3] as const) {
      expect(sliderPolicyForLevel(level, { brevity: "ultra" }).brevity).toBe("ultra");
      expect(sliderPolicyForLevel(level, { brevity: "off" }).brevity).toBe("off");
    }
    // "auto" is what opts back into the preset table.
    expect(sliderPolicyForLevel(SliderLevel.Balanced, { brevity: "auto" }).brevity).toBe("lite");
  });

  it("SAFETY CLAMP: a pinned compression level of 0 must NOT disable redaction", () => {
    // LEVEL_TABLE[0] is the only row with redaction:false. If a pinned 0 were
    // honoured at slider >=1, a config file could silently switch redaction off
    // — a CLAUDE.md hard-rule violation. It must clamp to 1 instead.
    for (const level of [1, 2, 3] as const) {
      const policy = sliderPolicyForLevel(level, { compression: 0 });
      expect(policy.compressionLevel).toBe(MIN_ACTIVE_COMPRESSION_LEVEL);
      expect(policy.stages.redaction).toBe(true);
    }
    expect(resolveCompressionLevel(1, 0)).toBe(1);
    expect(MIN_ACTIVE_COMPRESSION_LEVEL).toBe(1);
  });

  it("redaction is off ONLY when the slider itself is 0, whatever the dials say", () => {
    // The exhaustive statement of the hard rule across the whole dial space.
    for (const level of ALL_LEVELS) {
      for (const compression of ["auto", 0, 1, 2, 3] as const) {
        for (const brevity of ["auto", "off", "lite", "full", "ultra"] as const) {
          const policy = sliderPolicyForLevel(level, { compression, brevity });
          expect(policy.stages.redaction).toBe(level !== SliderLevel.Passthrough);
        }
      }
    }
  });

  it("passthrough is absolute — no pin can re-enable a stage or brevity at slider 0", () => {
    const policy = sliderPolicyForLevel(SliderLevel.Passthrough, {
      compression: 3,
      brevity: "ultra",
    });
    expect(policy.compressionLevel).toBe(0);
    expect(policy.brevity).toBe("off");
    expect(policy.stages.redaction).toBe(false);
    expect(policy.stages.losslessCompression).toBe(false);
    expect(policy.stages.semanticCompression).toBe("off");
    expect(resolveBrevity(SliderLevel.Passthrough, "ultra")).toBe(BrevityLevel.Off);
    expect(resolveCompressionLevel(SliderLevel.Passthrough, 3)).toBe(0);
  });

  it("a pinned compression level selects that row's stages, not the slider's", () => {
    const policy = sliderPolicyForLevel(SliderLevel.Aggressive, { compression: 1 });
    expect(policy.level).toBe(3); // identity for telemetry/displays is still the slider
    expect(policy.compressionLevel).toBe(1); // but the stages come from the pin
    expect(policy.stages.semanticCompression).toBe("off");
    expect(policy.stages.toolResultCache).toBe(false);
  });

  it("with no opts, compressionLevel tracks the slider and stages are unchanged", () => {
    for (const level of ALL_LEVELS) {
      const policy = sliderPolicyForLevel(level);
      expect(policy.compressionLevel).toBe(level);
      expect(policy.stages).toBe(sliderPolicyForLevel(level).stages);
    }
  });

  it("brevity defaults to OFF when omitted — a pre-Decision-52 caller is unaffected", () => {
    // Callers that predate the dial must not acquire an output-mutating stage
    // just by omitting an argument, and Decision 52 ships the dial off until the
    // telemetry rollup proves it pays. "auto" is the explicit opt-in.
    for (const level of ALL_LEVELS) {
      expect(sliderPolicyForLevel(level).brevity).toBe("off");
    }
    expect(sliderPolicyForLevel(SliderLevel.Aggressive, { brevity: "auto" }).brevity).toBe("full");
  });
});
