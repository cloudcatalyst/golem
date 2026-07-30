/**
 * §103: `resolveEffectiveCompression` predicts the two lossy-stage gates in
 * `runGolemPipeline`. These tests are the anti-drift pin — the prediction and the
 * enforcement must agree, because the whole point of the module is that `golem
 * status` stops reporting a level the pipeline will not apply.
 */

import { describe, expect, it } from "vitest";
import { SLIDER_LEVEL_NAMES } from "../../../src/cli/slider-read.js";
import {
  effectiveLevelBadge,
  effectiveLevelSuffix,
  isCachingUpstream,
  levelLabel,
  resolveEffectiveCompression,
} from "../../../src/compression/effective-level.js";
import type { SliderLevel } from "../../../src/interfaces/policy.js";

/** A non-caching upstream with the sidecar available — levels 2-3 fully live. */
const LIVE = {
  upstreamBaseUrl: "https://openrouter.ai/api/v1",
  assumeCachingUpstream: false,
  headroomSidecar: true,
  forceSemanticOnCaching: false,
} as const;

describe("isCachingUpstream", () => {
  it("treats the Anthropic API as caching", () => {
    expect(isCachingUpstream("https://api.anthropic.com")).toBe(true);
  });

  it("treats a non-Anthropic host as non-caching", () => {
    expect(isCachingUpstream("https://openrouter.ai/api/v1")).toBe(false);
    expect(isCachingUpstream("http://localhost:11434/v1")).toBe(false);
  });

  // The fail-safe direction is the point: guessing "not caching" would let the
  // history-rewriting stage run against a cache, measured at 8.7x-11.3x the cost
  // of not compressing at all (§103). Guessing "caching" only forgoes savings.
  it("answers caching for an absent URL (the Anthropic default)", () => {
    expect(isCachingUpstream(undefined)).toBe(true);
  });

  it("answers caching for an unparseable URL rather than guessing", () => {
    expect(isCachingUpstream("not a url")).toBe(true);
    expect(isCachingUpstream("")).toBe(true);
  });
});

describe("resolveEffectiveCompression", () => {
  it("never degrades levels 0 and 1 — they have no lossy stage to gate", () => {
    for (const level of [0, 1] as SliderLevel[]) {
      const r = resolveEffectiveCompression({
        level,
        upstreamBaseUrl: "https://api.anthropic.com",
        headroomSidecar: false,
        forceSemanticOnCaching: false,
      });
      expect(r).toEqual({ nominal: level, effective: level, degraded: false });
    }
  });

  it("collapses levels 2 and 3 to 1 on a caching upstream (Decision 31)", () => {
    for (const level of [2, 3] as SliderLevel[]) {
      const r = resolveEffectiveCompression({
        level,
        upstreamBaseUrl: "https://api.anthropic.com",
        headroomSidecar: true,
        forceSemanticOnCaching: false,
      });
      expect(r.nominal).toBe(level);
      expect(r.effective).toBe(1);
      expect(r.degraded).toBe(true);
      expect(r.reason).toMatch(/prompt-caching/);
    }
  });

  it("degrades on the DEFAULT upstream (absent base URL means Anthropic)", () => {
    const r = resolveEffectiveCompression({
      level: 3,
      headroomSidecar: true,
      forceSemanticOnCaching: false,
    });
    expect(r.effective).toBe(1);
    expect(r.degraded).toBe(true);
  });

  it("does not degrade on a non-caching upstream with the sidecar on", () => {
    for (const level of [2, 3] as SliderLevel[]) {
      const r = resolveEffectiveCompression({ ...LIVE, level });
      expect(r).toEqual({ nominal: level, effective: level, degraded: false });
    }
  });

  it("honours the forced-semantic research bypass on a caching upstream", () => {
    const r = resolveEffectiveCompression({
      level: 3,
      upstreamBaseUrl: "https://api.anthropic.com",
      headroomSidecar: true,
      forceSemanticOnCaching: true,
    });
    expect(r.degraded).toBe(false);
    expect(r.effective).toBe(3);
  });

  it("degrades when the sidecar is off, even on a non-caching upstream", () => {
    const r = resolveEffectiveCompression({ ...LIVE, level: 3, headroomSidecar: false });
    expect(r.effective).toBe(1);
    expect(r.degraded).toBe(true);
    expect(r.reason).toMatch(/sidecar/);
  });

  // The provider override is how case-(a) providers that serve Claude over the
  // Anthropic protocol are classified despite a non-anthropic.com host; it must
  // beat the URL heuristic in BOTH directions, as `effectiveCaching` does.
  it("lets an explicit provider override beat the URL heuristic", () => {
    const forcedCaching = resolveEffectiveCompression({
      level: 3,
      upstreamBaseUrl: "https://api.moonshot.ai/v1", // heuristic would say non-caching
      assumeCachingUpstream: true,
      headroomSidecar: true,
      forceSemanticOnCaching: false,
    });
    expect(forcedCaching.degraded).toBe(true);

    const forcedNonCaching = resolveEffectiveCompression({
      level: 3,
      upstreamBaseUrl: "https://api.anthropic.com", // heuristic would say caching
      assumeCachingUpstream: false,
      headroomSidecar: true,
      forceSemanticOnCaching: false,
    });
    expect(forcedNonCaching.degraded).toBe(false);
  });

  it("omits `reason` entirely when not degraded (exactOptionalPropertyTypes)", () => {
    const r = resolveEffectiveCompression({ ...LIVE, level: 3 });
    expect("reason" in r).toBe(false);
  });
});

describe("display helpers", () => {
  // The level names are duplicated so this module stays importable by the status
  // line without the config loader (§86). Duplication is fine; silent drift is not.
  it("keeps its level names identical to the CLI's", () => {
    for (const level of [0, 1, 2, 3] as SliderLevel[]) {
      expect(levelLabel(level)).toBe(SLIDER_LEVEL_NAMES[level]);
    }
  });

  it("renders nothing when nothing is degraded — the common case costs no width", () => {
    const ok = resolveEffectiveCompression({ ...LIVE, level: 3 });
    expect(effectiveLevelSuffix(ok)).toBe("");
    expect(effectiveLevelBadge(ok)).toBe("");
  });

  it("names the level that is RUNNING in the suffix, and the inert one in the badge", () => {
    const bad = resolveEffectiveCompression({
      level: 3,
      upstreamBaseUrl: "https://api.anthropic.com",
      headroomSidecar: true,
      forceSemanticOnCaching: false,
    });
    expect(effectiveLevelSuffix(bad)).toBe(" → effectively 1 (lossless)");
    expect(effectiveLevelBadge(bad)).toBe("⚠ 3 inert");
  });
});
