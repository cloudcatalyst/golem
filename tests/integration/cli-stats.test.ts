/**
 * WS-E task E3 — `golem stats` engine tests against a seeded CCR store.
 *
 * Drives a real NativeLosslessCompression through the StatsSource seam so the
 * report reflects genuine dedup savings and CCR activity, and checks the
 * pluggable seam accepts an alternate stats provider (the A4 telemetry path).
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  collectStats,
  collectWindowedStats,
  LIVE_STATS_NOTE,
  renderStats,
  statsSourceFor,
} from "../../src/cli/stats.js";
import { NativeLosslessCompression, STAGE_DEDUP } from "../../src/compression/index.js";
import type { Message } from "../../src/interfaces/compression.js";
import { policyFor } from "../../src/interfaces/index.js";
import type { TelemetryEvent } from "../../src/telemetry/index.js";
import { useTempDirs } from "../helpers/tmp.js";

const LEVEL_1 = policyFor(1);
const PROJECT = "stats-test-project";

/** A large payload so it clears the dedup min-chars threshold. */
const BIG = Array.from({ length: 40 }, (_, i) => `log line ${i}: event fired`).join("\n");

function userText(text: string): Message {
  return { role: "user", content: text };
}

const newTempDir = useTempDirs("golem-stats-");

describe("golem stats", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await newTempDir();
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

  it("R4.3: folds per-tool usage into the report and renders a local-tools section", async () => {
    const fake = statsSourceFor(
      {
        stats: () =>
          Promise.resolve({
            projectId: null,
            requests: 0,
            tokensBefore: 0,
            tokensAfter: 0,
            perStage: {},
            ccrRefsStored: 0,
            ccrRefsRetrieved: 0,
          }),
      },
      "telemetry",
      "durable history",
    );
    const report = await collectStats(fake, undefined, {
      projectId: null,
      byTool: {
        coder: { calls: 2, totalDurationMs: 1800, totalResultBytes: 3000, draftChars: 800 },
        search: { calls: 5, totalDurationMs: 100, totalResultBytes: 2000, draftChars: 0 },
      },
    });
    expect(report.tool_usage?.coder?.calls).toBe(2);
    const rendered = renderStats(report);
    expect(rendered).toContain("local tools:");
    expect(rendered).toContain("coder");
    expect(rendered).toContain("tokens drafted");
  });

  it("R4.3: omits the tool_usage section when no tool events were recorded", async () => {
    const fake = statsSourceFor(
      {
        stats: () =>
          Promise.resolve({
            projectId: null,
            requests: 1,
            tokensBefore: 10,
            tokensAfter: 5,
            perStage: {},
            ccrRefsStored: 0,
            ccrRefsRetrieved: 0,
          }),
      },
      "telemetry",
      "durable history",
    );
    const report = await collectStats(fake, undefined, { projectId: null, byTool: {} });
    expect(report.tool_usage).toBeUndefined();
    expect(renderStats(report)).not.toContain("local tools:");
  });
});

describe("collectWindowedStats (rolling savings window, Decision 23)", () => {
  const NOW = Date.parse("2026-07-24T12:00:00.000Z");
  function reqEvent(ts: string, before: number, after: number): TelemetryEvent {
    return {
      ts,
      projectId: PROJECT,
      level: 1,
      kind: "request",
      requestTokens: { tokensBefore: before, tokensAfter: after },
      stageSavings: {},
      ccrRefsStored: 0,
    };
  }
  // 1h ago (inside 24h), 3d ago (inside 7d only), and 8 weeks ago (all-time only).
  const events = [
    reqEvent("2026-07-24T11:00:00.000Z", 1000, 400),
    reqEvent("2026-07-21T12:00:00.000Z", 2000, 1000),
    reqEvent("2026-05-29T12:00:00.000Z", 5000, 4000),
  ];

  it("scopes the numbers to the requested 24h window", () => {
    const report = collectWindowedStats(events, { window: "24h", nowMs: NOW, projectId: PROJECT });
    expect(report.requests).toBe(1);
    expect(report.tokens_before).toBe(1000);
    expect(report.tokens_after).toBe(400);
    expect(report.window).toBe("24h");
    expect(report.window_applied).toBe("24h");
  });

  it("includes the 7d event when the window is 7d", () => {
    const report = collectWindowedStats(events, { window: "7d", nowMs: NOW, projectId: PROJECT });
    expect(report.requests).toBe(2);
    expect(report.tokens_before).toBe(3000);
    expect(report.window_applied).toBe("7d");
  });

  it("widens 24h → 7d → all when the narrower window recorded nothing", () => {
    // Only the 8-weeks-ago event exists → 24h and 7d are empty, so it falls back to all.
    const report = collectWindowedStats([events[2] as TelemetryEvent], {
      window: "24h",
      nowMs: NOW,
      projectId: PROJECT,
    });
    expect(report.requests).toBe(1);
    expect(report.window).toBe("24h");
    expect(report.window_applied).toBe("all");
  });

  it("labels the applied window in the human render (requested→applied when they differ)", () => {
    const report = collectWindowedStats([events[2] as TelemetryEvent], {
      window: "24h",
      nowMs: NOW,
    });
    expect(renderStats(report)).toContain("24h→all");
  });
});
