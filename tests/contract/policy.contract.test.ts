/**
 * Contract tests for the frozen PipelinePolicy level table (plan §2.4).
 *
 * These run today (policy.ts is pure data). If a change here is needed, the
 * interface is changing — flag all workstreams.
 *
 * R11.1 / ADR-0004 retired the slider. The scale is now the compression DIAL —
 * `off | 1 | 2 | 3` — set directly, with no preset and no `auto`. The most
 * load-bearing test in this file is the one that used to be a *clamp* test: a
 * dial value can no longer disable redaction, because no row of the table has
 * `redaction: false` any more. The bypass moved to `proxy.bypass_all`, which the
 * proxy applies before it ever asks for a policy.
 */

import { describe, expect, it } from "vitest";
import {
  BREVITY_LEVELS,
  BrevityLevel,
  COMPRESSION_LEVELS,
  CompressionLevel,
  coerceCompressionLevel,
  compressionName,
  compressionRank,
  policyFor,
  stagesForCompression,
} from "../../src/interfaces/policy.js";

const ALL_LEVELS = ["off", 1, 2, 3] as const;

describe("PipelinePolicy level table", () => {
  /**
   * The invariant R11.1 bought. Before it, `LEVEL_TABLE[0]` had
   * `redaction: false` and `MIN_ACTIVE_COMPRESSION_LEVEL` existed to stop a
   * pinned dial selecting that row. Now the row does not exist, so there is
   * nothing to clamp — the guarantee is structural rather than defended.
   */
  it("NO compression level can disable redaction (ADR-0004)", () => {
    for (const level of ALL_LEVELS) {
      expect(policyFor(level).stages.redaction).toBe(true);
    }
    // Stated over the whole dial space, brevity included, since brevity has no
    // business touching redaction either.
    for (const level of ALL_LEVELS) {
      for (const brevity of BREVITY_LEVELS) {
        expect(policyFor(level, { brevity }).stages.redaction).toBe(true);
      }
    }
  });

  it("`off` is redaction ONLY — nothing else runs", () => {
    const stages = policyFor(CompressionLevel.Off).stages;
    expect(stages.redaction).toBe(true);
    expect(stages.losslessCompression).toBe(false);
    expect(stages.toolResultCache).toBe(false);
    expect(stages.semanticCompression).toBe("off");
    expect(stages.semanticCache).toBe("off");
  });

  it("level 1 is lossless only (byte-faithful)", () => {
    const stages = policyFor(CompressionLevel.Lossless).stages;
    expect(stages.redaction).toBe(true);
    expect(stages.losslessCompression).toBe(true);
    expect(stages.semanticCompression).toBe("off");
  });

  it("level 2 (balanced) adds stale-turn semantic compression + strict semantic cache", () => {
    const stages = policyFor(CompressionLevel.Balanced).stages;
    expect(stages.losslessCompression).toBe(true);
    expect(stages.semanticCompression).toBe("stale_turns");
    expect(stages.semanticCache).toBe("strict");
  });

  it("level 3 (aggressive) enables max semantic compression (no local drafts — Decision 31)", () => {
    const stages = policyFor(CompressionLevel.Aggressive).stages;
    expect(stages.semanticCompression).toBe("aggressive");
    expect(stages.semanticCache).toBe("loose");
    // A pure compression dial — no local-model fields exist.
    expect("localDrafts" in stages).toBe(false);
    expect("localOnlyAnswers" in stages).toBe(false);
  });

  it("raising the level never turns a savings stage off (monotonicity)", () => {
    // R11.1: this now covers the WHOLE scale. It used to start at level 1,
    // because redaction was deliberately non-monotonic (off at 0, on at 1+) —
    // the exception that ADR-0004 removed.
    for (let i = 1; i < ALL_LEVELS.length; i++) {
      const lower = stagesForCompression(ALL_LEVELS[i - 1] as CompressionLevel);
      const higher = stagesForCompression(ALL_LEVELS[i] as CompressionLevel);
      expect(Number(higher.redaction)).toBeGreaterThanOrEqual(Number(lower.redaction));
      expect(Number(higher.losslessCompression)).toBeGreaterThanOrEqual(
        Number(lower.losslessCompression),
      );
      expect(Number(higher.toolResultCache)).toBeGreaterThanOrEqual(Number(lower.toolResultCache));
    }
  });

  it("COMPRESSION_LEVELS is weakest-first and frozen", () => {
    expect(COMPRESSION_LEVELS).toEqual(["off", 1, 2, 3]);
    expect(Object.isFrozen(COMPRESSION_LEVELS)).toBe(true);
  });

  it("names every level, and ranks `off` at 0 for telemetry bucketing", () => {
    expect(COMPRESSION_LEVELS.map(compressionName)).toEqual([
      "off",
      "lossless",
      "balanced",
      "aggressive",
    ]);
    expect(COMPRESSION_LEVELS.map(compressionRank)).toEqual([0, 1, 2, 3]);
  });

  it("coerceCompressionLevel is idempotent, and a stored 0 becomes `off` not a bypass", () => {
    for (const level of ALL_LEVELS) {
      expect(coerceCompressionLevel(level)).toBe(level);
      expect(coerceCompressionLevel(coerceCompressionLevel(level))).toBe(level);
    }
    // A pre-R11.1 file: 0 meant "bypass everything, redaction included". It
    // resolves to `off` — redaction ON — because this is the last-resort clamp and
    // it must fail toward MORE protection. Turning the real bypass on is the
    // migration's job, once, visibly (src/config/migrate-files.ts).
    expect(coerceCompressionLevel(0)).toBe("off");
    expect(policyFor(coerceCompressionLevel(0)).stages.redaction).toBe(true);
    // Legacy 4/5 still clamp to 3, as they did on the retired scale.
    expect([4, 5, 99].map(coerceCompressionLevel)).toEqual([3, 3, 3]);
    // Strings (settings/env carry strings) and junk.
    expect(coerceCompressionLevel("2")).toBe(2);
    expect(coerceCompressionLevel("nonsense")).toBe(1);
  });

  it("policies are frozen", () => {
    const policy = policyFor(CompressionLevel.Lossless);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.stages)).toBe(true);
    expect(Object.isFrozen(policy.overrides)).toBe(true);
  });
});

/**
 * The two dials. R11.1 removed the preset that used to sit above them, so what is
 * left to pin is that they are independent and that neither acquires behaviour a
 * caller did not ask for.
 */
describe("PipelinePolicy dials", () => {
  it("BREVITY_LEVELS is weakest-first and frozen", () => {
    expect(BREVITY_LEVELS).toEqual(["off", "lite", "full", "ultra"]);
    expect(Object.isFrozen(BREVITY_LEVELS)).toBe(true);
  });

  it("brevity is whatever it is set to, at every compression level", () => {
    // No preset table: the dials do not influence each other, which is the whole
    // point of retiring the thing that made them look like they did.
    for (const level of ALL_LEVELS) {
      for (const brevity of BREVITY_LEVELS) {
        expect(policyFor(level, { brevity }).brevity).toBe(brevity);
      }
    }
  });

  it("brevity defaults to OFF when omitted", () => {
    // A caller must not acquire an output-mutating stage by leaving an argument
    // out (Decision 52's reasoning, which survives the slider).
    for (const level of ALL_LEVELS) {
      expect(policyFor(level).brevity).toBe(BrevityLevel.Off);
    }
  });

  it("compression defaults to `off` when omitted — the safe end of the scale", () => {
    expect(policyFor().compression).toBe(CompressionLevel.Off);
    // And even that still redacts.
    expect(policyFor().stages.redaction).toBe(true);
  });

  it("the compression value selects that row's stages", () => {
    const policy = policyFor(CompressionLevel.Lossless);
    expect(policy.compression).toBe(1);
    expect(policy.stages.semanticCompression).toBe("off");
    expect(policy.stages.toolResultCache).toBe(false);
    // R11.1: there is ONE level-ish field now. There used to be two (`level` and
    // `compressionLevel`), which differed whenever a dial was pinned — so every
    // display had to know which one not to trust.
    expect("level" in policy).toBe(false);
    expect("compressionLevel" in policy).toBe(false);
  });
});
