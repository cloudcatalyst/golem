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
  MAX_SLIDER_LEVEL,
  migrateSliderLevel,
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
