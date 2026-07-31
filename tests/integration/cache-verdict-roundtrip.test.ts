/**
 * R8.1 — the cache verdict must survive the telemetry store, not just the aggregator.
 *
 * This test exists because it did not. `aggregateCacheStats` was unit-tested by
 * feeding it `TelemetryEvent` objects directly, which passes happily while the
 * store's `parseEvent` — a field-by-field allow-list — silently drops the new
 * fields on read. The proxy wrote 142 verdicts to disk and `golem stats --cache`
 * reported "none recorded".
 *
 * So: write through the real store, read back through the real reader, aggregate,
 * and assert. Any future `TelemetryEvent` field should get a case here.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aggregateCacheStats } from "../../src/telemetry/cache-report.js";
import {
  BUILTIN_MODEL_CATALOG,
  buildCostBenchmark,
  JsonlTelemetryStore,
  readTelemetryEvents,
} from "../../src/telemetry/index.js";
import type { TelemetryEvent } from "../../src/telemetry/types.js";
import { rmTemp } from "../helpers/tmp.js";

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-verdict-rt-"));
});

afterEach(async () => {
  await rm(projectDir, rmTemp);
});

function pipelineEvent(over: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    ts: "2026-07-30T00:00:00.000Z",
    projectId: projectDir,
    level: 3,
    requestTokens: { tokensBefore: 100, tokensAfter: 90 },
    stageSavings: {},
    ccrRefsStored: 0,
    ...over,
  };
}

describe("cache verdicts survive a store round-trip", () => {
  it("carries cachePrefix through write -> read -> aggregate", async () => {
    const store = new JsonlTelemetryStore(projectDir);
    await store.record(pipelineEvent({ cachePrefix: "first" }));
    await store.record(pipelineEvent({ cachePrefix: "append" }));
    await store.record(pipelineEvent({ cachePrefix: "append" }));

    const events = await readTelemetryEvents(projectDir);
    expect(events.map((e) => e.cachePrefix)).toEqual(["first", "append", "append"]);

    const stats = aggregateCacheStats(events);
    expect(stats.prefix).toEqual({ first: 1, append: 2, bust: 0, unobserved: 0 });
  });

  it("carries cacheBustComponent alongside a bust", async () => {
    const store = new JsonlTelemetryStore(projectDir);
    await store.record(pipelineEvent({ cachePrefix: "bust", cacheBustComponent: "tools" }));
    await store.record(pipelineEvent({ cachePrefix: "bust", cacheBustComponent: "messages" }));

    const stats = aggregateCacheStats(await readTelemetryEvents(projectDir));
    expect(stats.prefix.bust).toBe(2);
    expect(stats.busts.tools).toBe(1);
    expect(stats.busts.messages).toBe(1);
    expect(stats.busts.unattributed).toBe(0);
  });

  it("still reports an event written without a verdict as unobserved", async () => {
    const store = new JsonlTelemetryStore(projectDir);
    await store.record(pipelineEvent());
    const stats = aggregateCacheStats(await readTelemetryEvents(projectDir));
    expect(stats.prefix.unobserved).toBe(1);
    expect(stats.prefix.append).toBe(0);
  });

  // R8.13 — the same standing rule, applied to the two fields added for §104. An
  // index without a store line reads back as `undefined`, and `worstMessageBust`
  // would silently stay null while the proxy wrote depths to disk every turn.
  it("carries the bust depth (index + message count) through write -> read -> aggregate", async () => {
    const store = new JsonlTelemetryStore(projectDir);
    await store.record(
      pipelineEvent({
        cachePrefix: "bust",
        cacheBustComponent: "messages",
        cacheBustMessageIndex: 178,
        cacheMessageCount: 180,
      }),
    );
    await store.record(
      pipelineEvent({
        cachePrefix: "bust",
        cacheBustComponent: "messages",
        cacheBustMessageIndex: 12,
        cacheMessageCount: 190,
      }),
    );

    const events = await readTelemetryEvents(projectDir);
    expect(events.map((e) => e.cacheBustMessageIndex)).toEqual([178, 12]);
    expect(events.map((e) => e.cacheMessageCount)).toEqual([180, 190]);

    // The SHALLOWEST index wins — it is the one that re-prefilled the most history.
    const stats = aggregateCacheStats(events);
    expect(stats.worstMessageBust).toEqual({ index: 12, messageCount: 190 });
  });

  it("counts a lookback bust apart from the content components", async () => {
    const store = new JsonlTelemetryStore(projectDir);
    await store.record(pipelineEvent({ cachePrefix: "bust", cacheBustComponent: "lookback" }));

    const stats = aggregateCacheStats(await readTelemetryEvents(projectDir));
    expect(stats.busts.lookback).toBe(1);
    expect(stats.busts.messages).toBe(0);
    expect(stats.busts.unattributed).toBe(0);
    expect(stats.worstMessageBust).toBeNull();
  });

  it("keeps billed usage and verdicts independent across the round-trip", async () => {
    const store = new JsonlTelemetryStore(projectDir);
    await store.record(pipelineEvent({ cachePrefix: "append" }));
    await store.record({
      ts: "2026-07-30T00:00:01.000Z",
      projectId: projectDir,
      level: 3,
      kind: "usage",
      stageSavings: {},
      ccrRefsStored: 0,
      usage: {
        inputTokens: 100,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 900,
        outputTokens: 50,
      },
    });

    const stats = aggregateCacheStats(await readTelemetryEvents(projectDir));
    expect(stats.samples).toBe(1);
    expect(stats.cacheReadTokens).toBe(900);
    expect(stats.prefix.append).toBe(1);
    expect(stats.prefix.unobserved).toBe(0);
  });
});

/**
 * R8.8 — the same failure, one release later: the proxy wrote `model` /
 * `modelProvider` on every usage sample and `golem bench cost` still reported
 * 1,503 unattributed samples, because `parseEvent`'s allow-list did not carry
 * them. Found by running the real command against real telemetry, not by a unit
 * test — hence this case.
 */
describe("the billed model survives a store round-trip (R8.8)", () => {
  it("carries model and provider through write → read → spend", async () => {
    const store = new JsonlTelemetryStore(projectDir);
    await store.record({
      ts: "2026-07-31T00:00:00.000Z",
      projectId: projectDir,
      level: 1,
      kind: "usage",
      stageSavings: {},
      ccrRefsStored: 0,
      usage: {
        inputTokens: 1_000_000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      },
      model: "claude-opus-5",
      modelProvider: "anthropic",
    });

    const events = await readTelemetryEvents(projectDir);
    expect(events[0]?.model).toBe("claude-opus-5");
    expect(events[0]?.modelProvider).toBe("anthropic");

    // And it composes: the spend rollup prices it instead of calling it unattributed.
    const report = buildCostBenchmark(events, {
      window: "all",
      nowMs: Date.parse("2026-07-31T01:00:00.000Z"),
      catalog: BUILTIN_MODEL_CATALOG,
    });
    expect(report.spend?.unattributed_requests).toBe(0);
    expect(report.spend?.by_model[0]?.model).toBe("claude-opus-5");
    expect(report.spend?.by_model[0]?.usd).toBe(5);
  });
});
