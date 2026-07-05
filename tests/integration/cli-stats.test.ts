/**
 * WS-E task E3 — `golem stats` engine tests against a seeded CCR store.
 *
 * Drives a real NativeLosslessCompression through the StatsSource seam so the
 * report reflects genuine dedup savings and CCR activity, and checks the
 * pluggable seam accepts an alternate stats provider (the A4 telemetry path).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectStats, LIVE_STATS_NOTE, statsSourceFor } from "../../src/cli/stats.js";
import { NativeLosslessCompression, STAGE_DEDUP } from "../../src/compression/index.js";
import type { Message } from "../../src/interfaces/compression.js";
import { sliderPolicyForLevel } from "../../src/interfaces/index.js";

const LEVEL_1 = sliderPolicyForLevel(1);
const PROJECT = "stats-test-project";

/** A large payload so it clears the dedup min-chars threshold. */
const BIG = Array.from({ length: 40 }, (_, i) => `log line ${i}: event fired`).join("\n");

function userText(text: string): Message {
  return { role: "user", content: text };
}

describe("golem stats", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "golem-stats-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("reports genuine savings and CCR activity from a seeded store", async () => {
    const svc = NativeLosslessCompression.forProjectDir(projectDir);
    // Two identical big payloads -> the second is deduped into a CCR ref.
    await svc.compress([userText(BIG), userText(BIG)], LEVEL_1, PROJECT);

    const report = await collectStats(statsSourceFor(svc, "live", LIVE_STATS_NOTE), PROJECT);

    expect(report.source).toBe("live");
    expect(report.project_id).toBe(PROJECT);
    expect(report.requests).toBe(1);
    expect(report.tokens_before).toBeGreaterThan(report.tokens_after);
    expect(report.tokens_saved).toBe(report.tokens_before - report.tokens_after);
    expect(report.ccr_refs_stored).toBe(1);
    expect(report.per_stage[STAGE_DEDUP]).toBeDefined();
    expect(report.per_stage[STAGE_DEDUP]?.tokens_saved).toBeGreaterThan(0);
    expect(report.note).toBe(LIVE_STATS_NOTE);
  });

  it("reports zeroed stats for an unseen project", async () => {
    const svc = NativeLosslessCompression.forProjectDir(projectDir);
    const report = await collectStats(statsSourceFor(svc, "live", LIVE_STATS_NOTE), "never-seen");
    expect(report.requests).toBe(0);
    expect(report.tokens_saved).toBe(0);
    expect(report.per_stage).toEqual({});
  });

  it("accepts an alternate stats provider through the seam (A4 telemetry path)", async () => {
    const fake = statsSourceFor(
      {
        stats: () =>
          Promise.resolve({
            projectId: null,
            requests: 7,
            tokensBefore: 1000,
            tokensAfter: 600,
            perStage: { dedup: { tokensBefore: 1000, tokensAfter: 600 } },
            ccrRefsStored: 3,
            ccrRefsRetrieved: 1,
          }),
      },
      "telemetry",
      "durable history",
    );
    const report = await collectStats(fake);
    expect(report.source).toBe("telemetry");
    expect(report.tokens_saved).toBe(400);
    expect(report.per_stage.dedup?.tokens_saved).toBe(400);
    expect(report.note).toBe("durable history");
  });
});
