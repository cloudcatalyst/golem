/**
 * WS-A A4 — durable JSONL telemetry store: aggregation, restart survival,
 * corruption tolerance, per-project scoping, concurrent-append safety.
 */

import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TelemetryEvent } from "../../../src/telemetry/index.js";
import {
  JsonlTelemetryStore,
  recordPipelineEvent,
  recordRetrieval,
  telemetryFilePath,
  telemetryStatsSource,
} from "../../../src/telemetry/index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "golem-tel-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ev(over: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    ts: "2026-07-04T00:00:00.000Z",
    projectId: "projA",
    level: 1,
    stageSavings: {
      redaction: { tokensBefore: 100, tokensAfter: 100 },
      dedup: { tokensBefore: 100, tokensAfter: 60 },
    },
    ccrRefsStored: 1,
    ...over,
  };
}

describe("JsonlTelemetryStore", () => {
  it("aggregates request count, series before/after, per-stage, and CCR refs", async () => {
    const store = new JsonlTelemetryStore(dir);
    await store.record(ev());
    await store.record(ev());
    const stats = await store.aggregate();
    expect(stats.requests).toBe(2);
    // Series semantics: request before = first stage's before (100),
    // after = last stage's after (60). Summed over 2 requests.
    expect(stats.tokensBefore).toBe(200);
    expect(stats.tokensAfter).toBe(120);
    expect(stats.ccrRefsStored).toBe(2);
    expect(stats.perStage.dedup).toStrictEqual({ tokensBefore: 200, tokensAfter: 120 });
    await store.close();
  });

  it("survives process restart — a fresh store reads prior events", async () => {
    const first = new JsonlTelemetryStore(dir);
    await first.record(ev());
    await first.close();

    // Simulate a new process: brand-new instance over the same dir.
    const second = new JsonlTelemetryStore(dir);
    const stats = await second.aggregate();
    expect(stats.requests).toBe(1);
    expect(stats.tokensAfter).toBe(60);
    await second.close();
  });

  it("scopes aggregation by projectId, and global sees all", async () => {
    const store = new JsonlTelemetryStore(dir);
    await store.record(ev({ projectId: "projA" }));
    await store.record(ev({ projectId: "projB" }));
    expect((await store.aggregate("projA")).requests).toBe(1);
    expect((await store.aggregate("projB")).requests).toBe(1);
    expect((await store.aggregate()).requests).toBe(2);
    expect((await store.aggregate("projA")).projectId).toBe("projA");
    expect((await store.aggregate()).projectId).toBeNull();
    await store.close();
  });

  it("skips a corrupt/partial trailing line rather than throwing", async () => {
    const store = new JsonlTelemetryStore(dir);
    await store.record(ev());
    // Simulate a crash mid-write: a partial JSON line with no newline.
    await appendFile(telemetryFilePath(dir), '{"ts":"x","projectId":"projA","stageSa', "utf8");
    const stats = await store.aggregate();
    expect(stats.requests).toBe(1); // the good event still counts
    await store.close();
  });

  it("returns empty stats when no telemetry file exists yet", async () => {
    const store = new JsonlTelemetryStore(dir);
    const stats = await store.aggregate();
    expect(stats.requests).toBe(0);
    expect(stats.tokensBefore).toBe(0);
    expect(stats.perStage).toStrictEqual({});
    await store.close();
  });

  it("serializes concurrent appends without interleaving lines", async () => {
    const store = new JsonlTelemetryStore(dir);
    await Promise.all(Array.from({ length: 25 }, () => store.record(ev())));
    const stats = await store.aggregate();
    expect(stats.requests).toBe(25); // all 25 lines intact and parseable
    await store.close();
  });
});

describe("recordPipelineEvent + telemetryStatsSource", () => {
  it("adapts a PipelineEvent and reads it back through the StatsSource seam", async () => {
    const store = new JsonlTelemetryStore(dir);
    await recordPipelineEvent(
      store,
      {
        projectId: "projA",
        level: 2,
        // Whole-request total differs from the per-stage numbers on purpose:
        // the headline must use requestTokens, not the stage stitch.
        requestTokens: { tokensBefore: 1000, tokensAfter: 400 },
        stageSavings: { dedup: { tokensBefore: 500, tokensAfter: 300 } },
        ccrRefsStored: 3,
      },
      "2026-07-04T12:00:00.000Z",
    );
    const source = telemetryStatsSource(store);
    expect(source.kind).toBe("telemetry");
    const stats = await source.stats("projA");
    expect(stats.requests).toBe(1);
    // requestTokens (1000→400), NOT the dedup stage (500→300).
    expect(stats.tokensBefore).toBe(1000);
    expect(stats.tokensAfter).toBe(400);
    expect(stats.perStage.dedup).toStrictEqual({ tokensBefore: 500, tokensAfter: 300 });
    expect(stats.ccrRefsStored).toBe(3);
    await store.close();
  });

  it("legacy events (no requestTokens) fall back to the stage stitch", async () => {
    const store = new JsonlTelemetryStore(dir);
    await store.record(ev()); // ev() has no requestTokens
    const stats = await store.aggregate();
    // Falls back to first-before (100) / last-after (60).
    expect(stats.tokensBefore).toBe(100);
    expect(stats.tokensAfter).toBe(60);
    await store.close();
  });
});

describe("recordRetrieval (T1, §25)", () => {
  it("counts toward ccrRefsRetrieved without inflating requests or token savings", async () => {
    const store = new JsonlTelemetryStore(dir);
    await recordPipelineEvent(
      store,
      {
        projectId: "projA",
        level: 2,
        requestTokens: { tokensBefore: 1000, tokensAfter: 400 },
        stageSavings: {},
        ccrRefsStored: 1,
      },
      "2026-07-10T00:00:00.000Z",
    );
    await recordRetrieval(store, "projA", "2026-07-10T00:00:01.000Z");
    await recordRetrieval(store, "projA", "2026-07-10T00:00:02.000Z", 3);

    const stats = await store.aggregate("projA");
    expect(stats.ccrRefsRetrieved).toBe(4); // 1 + 3
    // Only the one pipeline event counts as a request; retrievals don't.
    expect(stats.requests).toBe(1);
    expect(stats.tokensBefore).toBe(1000);
    expect(stats.tokensAfter).toBe(400);
    await store.close();
  });

  it("scopes retrievals by projectId like everything else", async () => {
    const store = new JsonlTelemetryStore(dir);
    await recordRetrieval(store, "projA", "2026-07-10T00:00:00.000Z");
    await recordRetrieval(store, "projB", "2026-07-10T00:00:00.000Z", 2);
    expect((await store.aggregate("projA")).ccrRefsRetrieved).toBe(1);
    expect((await store.aggregate("projB")).ccrRefsRetrieved).toBe(2);
    expect((await store.aggregate()).ccrRefsRetrieved).toBe(3);
    await store.close();
  });

  it("survives an old JSONL line with no kind field (backward compatible)", async () => {
    const store = new JsonlTelemetryStore(dir);
    await store.record(ev()); // ev() predates the `kind` field entirely
    const stats = await store.aggregate();
    expect(stats.requests).toBe(1); // absent kind must still parse as "request"
    expect(stats.ccrRefsRetrieved).toBe(0);
    await store.close();
  });
});
