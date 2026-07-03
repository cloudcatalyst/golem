/**
 * Contract tests for the frozen SliderPolicy level table (plan §2.4).
 *
 * These run today (policy.ts is pure data). If a change here is needed,
 * the interface is changing — flag all workstreams.
 */

import { describe, expect, it } from "vitest";
import { effectiveStages, SliderLevel, sliderPolicyForLevel } from "../../src/interfaces/policy.js";

const ALL_LEVELS = [0, 1, 2, 3, 4, 5] as const;

describe("SliderPolicy level table", () => {
  it("redaction is always on, at every slider level (hard rule)", () => {
    for (const level of ALL_LEVELS) {
      expect(sliderPolicyForLevel(level).stages.redaction).toBe(true);
    }
  });

  it("level 0 is passthrough", () => {
    const stages = sliderPolicyForLevel(SliderLevel.Passthrough).stages;
    expect(stages.losslessCompression).toBe(false);
    expect(stages.toolResultCache).toBe(false);
    expect(stages.semanticCompression).toBe("off");
    expect(stages.semanticCache).toBe("off");
    expect(stages.localDrafts).toBe(false);
    expect(stages.localOnlyAnswers).toBe(false);
  });

  it("level 1 is lossless only", () => {
    const stages = sliderPolicyForLevel(SliderLevel.Lossless).stages;
    expect(stages.losslessCompression).toBe(true);
    expect(stages.toolResultCache).toBe(false);
    expect(stages.semanticCompression).toBe("off");
  });

  it("level 2 adds tool-result caching", () => {
    const stages = sliderPolicyForLevel(SliderLevel.Conservative).stages;
    expect(stages.toolResultCache).toBe(true);
    expect(stages.semanticCompression).toBe("off");
    expect(stages.semanticCache).toBe("off");
  });

  it("level 3 enables stale-turn compression + strict semantic cache", () => {
    const stages = sliderPolicyForLevel(SliderLevel.Balanced).stages;
    expect(stages.semanticCompression).toBe("stale_turns");
    expect(stages.semanticCache).toBe("strict");
    expect(stages.localDrafts).toBe(false);
  });

  it("level 4 enables drafts + normal semantic cache", () => {
    const stages = sliderPolicyForLevel(SliderLevel.Aggressive).stages;
    expect(stages.semanticCompression).toBe("low_relevance");
    expect(stages.semanticCache).toBe("normal");
    expect(stages.localDrafts).toBe(true);
    expect(stages.localOnlyAnswers).toBe(false);
  });

  it("level-5 local-only answers require per-project opt-in (spec §9.7)", () => {
    const byDefault = sliderPolicyForLevel(SliderLevel.MaxSavings);
    expect(byDefault.stages.localOnlyAnswers).toBe(true);
    expect(effectiveStages(byDefault).localOnlyAnswers).toBe(false);

    const opted = sliderPolicyForLevel(SliderLevel.MaxSavings, { localOnlyOptIn: true });
    expect(effectiveStages(opted).localOnlyAnswers).toBe(true);
  });

  it("raising the slider never turns a savings stage off (monotonicity)", () => {
    for (const level of ALL_LEVELS) {
      if (level === 0) continue;
      const lower = sliderPolicyForLevel((level - 1) as (typeof ALL_LEVELS)[number]).stages;
      const higher = sliderPolicyForLevel(level).stages;
      expect(Number(higher.losslessCompression)).toBeGreaterThanOrEqual(
        Number(lower.losslessCompression),
      );
      expect(Number(higher.toolResultCache)).toBeGreaterThanOrEqual(Number(lower.toolResultCache));
      expect(Number(higher.localDrafts)).toBeGreaterThanOrEqual(Number(lower.localDrafts));
    }
  });

  it("policies are frozen", () => {
    const policy = sliderPolicyForLevel(SliderLevel.Lossless);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.stages)).toBe(true);
    expect(Object.isFrozen(policy.overrides)).toBe(true);
  });
});
