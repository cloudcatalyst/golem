/**
 * R6.4 — cost-governance benchmark (spec Decision 21f): pure folding of
 * telemetry events, windowing, per-tool attribution, honest-scope notes, and
 * the CLAUDE.md leanness check. Plus the raw event reader the benchmark needs.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TelemetryEvent } from "../../../src/telemetry/index.js";
import {
  buildCostBenchmark,
  COST_DOC_BASELINES,
  JsonlTelemetryStore,
  readTelemetryEvents,
  recordToolCall,
  renderCostBenchmark,
  windowStartMs,
} from "../../../src/telemetry/index.js";
import { rmTemp } from "../../helpers/tmp.js";

const NOW = Date.parse("2026-07-23T12:00:00.000Z");
const DAY = 86_400_000;

function ev(over: Partial<TelemetryEvent>): TelemetryEvent {
  return {
    ts: "2026-07-23T11:00:00.000Z",
    projectId: "projA",
    level: 1,
    stageSavings: {},
    ccrRefsStored: 0,
    ...over,
  };
}

describe("windowStartMs", () => {
  it("subtracts the window; all-time is null", () => {
    expect(windowStartMs("24h", NOW)).toBe(NOW - DAY);
    expect(windowStartMs("7d", NOW)).toBe(NOW - 7 * DAY);
    expect(windowStartMs("all", NOW)).toBeNull();
  });
});

describe("buildCostBenchmark", () => {
  it("folds each event kind into the right honestly-scoped bucket", () => {
    const events: TelemetryEvent[] = [
      ev({ kind: "request", ccrRefsStored: 3 }),
      ev({ kind: "request", ccrRefsStored: 1 }),
      ev({ kind: "retrieval", ccrRefsRetrieved: 5 }),
      ev({
        kind: "usage",
        usage: {
          inputTokens: 100,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 50,
        },
      }),
      ev({
        kind: "avoidedUpstream",
        avoidedUpstreamInputTokens: 200,
        avoidedUpstreamOutputTokens: 40,
      }),
      ev({ kind: "tool", tool: "search", toolDurationMs: 10, toolResultBytes: 500 }),
      ev({
        kind: "tool",
        tool: "coder",
        toolDurationMs: 20,
        toolResultBytes: 800,
        toolDraftChars: 400,
      }),
      ev({ kind: "tool", tool: "search", toolDurationMs: 30, toolResultBytes: 100 }),
    ];

    const r = buildCostBenchmark(events, { window: "all", nowMs: NOW });

    expect(r.golem_savings.requests).toBe(2);
    expect(r.golem_savings.ccr_refs_stored).toBe(4);
    expect(r.golem_savings.ccr_refs_retrieved).toBe(5);
    expect(r.golem_savings.net_of_cache_effective_input_tokens).toBe(100);
    expect(r.golem_savings.avoided_upstream_input_tokens).toBe(200);
    expect(r.golem_savings.avoided_upstream_output_tokens).toBe(40);
    expect(r.golem_savings.drafted_locally_chars).toBe(400);
    expect(r.golem_savings.drafted_locally_tokens_est).toBe(100);

    // 3 tool calls total: search 2/3, coder 1/3.
    expect(r.tool_attribution.search?.calls).toBe(2);
    expect(r.tool_attribution.search?.share_pct).toBe(66.7);
    expect(r.tool_attribution.coder?.calls).toBe(1);
    expect(r.tool_attribution.coder?.draft_chars).toBe(400);
    expect(r.tool_attribution.coder?.share_pct).toBe(33.3);
  });

  it("uses cache multipliers for net-of-cache effective input", () => {
    // 100 uncached + 1000 cache-read*0.1 + 40 cache-write*1.25 = 100 + 100 + 50 = 250.
    const r = buildCostBenchmark(
      [
        ev({
          kind: "usage",
          usage: {
            inputTokens: 100,
            cacheCreationInputTokens: 40,
            cacheReadInputTokens: 1000,
            outputTokens: 0,
          },
        }),
      ],
      { window: "all", nowMs: NOW },
    );
    expect(r.golem_savings.net_of_cache_effective_input_tokens).toBe(250);
  });

  it("excludes events outside the window and skips unparseable timestamps", () => {
    const events: TelemetryEvent[] = [
      ev({ kind: "request", ts: "2026-07-23T11:30:00.000Z" }), // 30m ago — in 24h
      ev({ kind: "request", ts: "2026-07-20T12:00:00.000Z" }), // 3d ago — out of 24h, in 7d
      ev({ kind: "request", ts: "not-a-date" }), // unparseable — skipped when windowed
    ];
    expect(buildCostBenchmark(events, { window: "24h", nowMs: NOW }).golem_savings.requests).toBe(
      1,
    );
    expect(buildCostBenchmark(events, { window: "7d", nowMs: NOW }).golem_savings.requests).toBe(2);
    // all-time imposes no lower bound, so the unparseable ts is still counted.
    expect(buildCostBenchmark(events, { window: "all", nowMs: NOW }).golem_savings.requests).toBe(
      3,
    );
  });

  it("scopes to a project when projectId is given", () => {
    const events: TelemetryEvent[] = [
      ev({ kind: "request", projectId: "projA" }),
      ev({ kind: "request", projectId: "projB" }),
    ];
    expect(
      buildCostBenchmark(events, { window: "all", nowMs: NOW, projectId: "projA" }).golem_savings
        .requests,
    ).toBe(1);
    expect(buildCostBenchmark(events, { window: "all", nowMs: NOW }).golem_savings.requests).toBe(
      2,
    );
  });

  it("reports CLAUDE.md leanness only when line count is provided", () => {
    expect(buildCostBenchmark([], { window: "all", nowMs: NOW }).claude_md).toBeUndefined();
    expect(
      buildCostBenchmark([], { window: "all", nowMs: NOW, claudeMdLines: 150 }).claude_md,
    ).toEqual({ lines: 150, recommended_max: 200, lean: true });
    expect(
      buildCostBenchmark([], { window: "all", nowMs: NOW, claudeMdLines: 250 }).claude_md?.lean,
    ).toBe(false);
  });

  it("always carries the honest-scope notes and the reference baselines", () => {
    const r = buildCostBenchmark([], { window: "all", nowMs: NOW });
    expect(r.notes.length).toBe(3);
    expect(r.notes.join(" ")).toMatch(/NOT a replacement for Claude Code's \/usage/);
    expect(r.baselines).toEqual(COST_DOC_BASELINES);
    expect(r.window_start).toBeNull();
    expect(r.generated_at).toBe("2026-07-23T12:00:00.000Z");
  });

  it("sets window_start for a bounded window", () => {
    const r = buildCostBenchmark([], { window: "24h", nowMs: NOW });
    expect(r.window_start).toBe(new Date(NOW - DAY).toISOString());
  });
});

describe("renderCostBenchmark", () => {
  it("renders the buckets, baselines-as-reference, and notes", () => {
    const out = renderCostBenchmark(
      buildCostBenchmark([ev({ kind: "tool", tool: "coder", toolDraftChars: 400 })], {
        window: "7d",
        nowMs: NOW,
        claudeMdLines: 150,
      }),
    );
    expect(out).toContain("cost-governance benchmark");
    expect(out).toContain("last 7d");
    expect(out).toContain("drafted locally");
    expect(out).toContain("reference, not a claimed delta");
    expect(out).toContain("CLAUDE.md: 150 lines");
    expect(out).toMatch(/note: /);
  });
});

describe("readTelemetryEvents", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-bench-"));
  });
  afterEach(async () => {
    await rm(dir, rmTemp);
  });

  it("returns [] when nothing was ever recorded", async () => {
    expect(await readTelemetryEvents(dir)).toEqual([]);
  });

  it("reads back recorded events for windowing", async () => {
    const store = new JsonlTelemetryStore(dir);
    await recordToolCall(
      store,
      { projectId: "projA", tool: "coder", durationMs: 5, resultBytes: 10, draftChars: 40 },
      "2026-07-23T11:00:00.000Z",
    );
    await store.close();
    const events = await readTelemetryEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("tool");
    expect(events[0]?.toolDraftChars).toBe(40);

    // And it composes through the benchmark end-to-end.
    const r = buildCostBenchmark(events, { window: "all", nowMs: NOW });
    expect(r.golem_savings.drafted_locally_chars).toBe(40);
  });
});
