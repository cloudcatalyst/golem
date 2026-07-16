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
  recordAvoidedUpstream,
  recordPipelineEvent,
  recordRetrieval,
  recordToolCall,
  recordUsageEvent,
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
        avoidedUpstreamInputTokens: 0,
        avoidedUpstreamOutputTokens: 0,
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
        avoidedUpstreamInputTokens: 0,
        avoidedUpstreamOutputTokens: 0,
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

describe("recordUsageEvent + aggregateUsageByLevel (R1.1, §30-37)", () => {
  it("rolls up usage totals and request counts per slider level", async () => {
    const store = new JsonlTelemetryStore(dir);
    await recordUsageEvent(
      store,
      {
        projectId: "projA",
        level: 1,
        usage: {
          inputTokens: 2095,
          cacheCreationInputTokens: 1024,
          cacheReadInputTokens: 1024,
          outputTokens: 89,
        },
      },
      "2026-07-11T00:00:00.000Z",
    );
    await recordUsageEvent(
      store,
      {
        projectId: "projA",
        level: 1,
        usage: {
          inputTokens: 100,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 500,
          outputTokens: 20,
        },
      },
      "2026-07-11T00:00:01.000Z",
    );
    await recordUsageEvent(
      store,
      {
        projectId: "projA",
        level: 3,
        usage: {
          inputTokens: 472,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 448,
          outputTokens: 189,
        },
      },
      "2026-07-11T00:00:02.000Z",
    );

    const byLevel = await store.aggregateUsageByLevel("projA");
    expect(byLevel.projectId).toBe("projA");
    expect(byLevel.byLevel[1]).toStrictEqual({
      requests: 2,
      inputTokens: 2195,
      cacheCreationInputTokens: 1024,
      cacheReadInputTokens: 1524,
      outputTokens: 109,
    });
    expect(byLevel.byLevel[3]).toStrictEqual({
      requests: 1,
      inputTokens: 472,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 448,
      outputTokens: 189,
    });
    await store.close();
  });

  it("keeps usage events out of the gross-token aggregate() headline", async () => {
    const store = new JsonlTelemetryStore(dir);
    await store.record(ev()); // one ordinary pipeline request
    await recordUsageEvent(
      store,
      {
        projectId: "projA",
        level: 1,
        usage: {
          inputTokens: 2095,
          cacheCreationInputTokens: 1024,
          cacheReadInputTokens: 1024,
          outputTokens: 89,
        },
      },
      "2026-07-11T00:00:00.000Z",
    );
    const stats = await store.aggregate("projA");
    expect(stats.requests).toBe(1); // usage event does not count as a request
    await store.close();
  });

  it("scopes aggregateUsageByLevel by projectId, and global sees all", async () => {
    const store = new JsonlTelemetryStore(dir);
    await recordUsageEvent(
      store,
      {
        projectId: "projA",
        level: 1,
        usage: {
          inputTokens: 10,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 1,
        },
      },
      "2026-07-11T00:00:00.000Z",
    );
    await recordUsageEvent(
      store,
      {
        projectId: "projB",
        level: 1,
        usage: {
          inputTokens: 20,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 2,
        },
      },
      "2026-07-11T00:00:01.000Z",
    );
    expect((await store.aggregateUsageByLevel("projA")).byLevel[1]?.requests).toBe(1);
    expect((await store.aggregateUsageByLevel("projB")).byLevel[1]?.requests).toBe(1);
    expect((await store.aggregateUsageByLevel()).byLevel[1]?.requests).toBe(2);
    await store.close();
  });

  it("returns an empty byLevel map when no telemetry file exists yet", async () => {
    const store = new JsonlTelemetryStore(dir);
    const byLevel = await store.aggregateUsageByLevel();
    expect(byLevel.byLevel).toStrictEqual({});
    expect(byLevel.projectId).toBeNull();
    await store.close();
  });

  it("old lines without kind/usage still parse and are ignored by aggregateUsageByLevel", async () => {
    const store = new JsonlTelemetryStore(dir);
    await store.record(ev()); // no `kind`, no `usage` field at all
    const byLevel = await store.aggregateUsageByLevel();
    expect(byLevel.byLevel).toStrictEqual({});
    const stats = await store.aggregate();
    expect(stats.requests).toBe(1); // unaffected — still parses as an ordinary request
    await store.close();
  });
});

describe("recordUsageEvent + aggregateUsageBySemanticForced (R2.6, §58/§59)", () => {
  it("buckets usage totals by the semanticForced tag, independent of level", async () => {
    const store = new JsonlTelemetryStore(dir);
    await recordUsageEvent(
      store,
      {
        projectId: "projA",
        level: 3,
        usage: {
          inputTokens: 10,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 1000,
          outputTokens: 5,
        },
        semanticForced: true,
      },
      "2026-07-11T00:00:00.000Z",
    );
    await recordUsageEvent(
      store,
      {
        projectId: "projA",
        level: 3,
        usage: {
          inputTokens: 20,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 100,
          outputTokens: 8,
        },
        semanticForced: false,
      },
      "2026-07-11T00:00:01.000Z",
    );

    const byForced = await store.aggregateUsageBySemanticForced("projA");
    expect(byForced.projectId).toBe("projA");
    expect(byForced.forced).toStrictEqual({
      requests: 1,
      inputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 1000,
      outputTokens: 5,
    });
    expect(byForced.notForced).toStrictEqual({
      requests: 1,
      inputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 100,
      outputTokens: 8,
    });
    await store.close();
  });

  it("defaults semanticForced to false when omitted", async () => {
    const store = new JsonlTelemetryStore(dir);
    await recordUsageEvent(
      store,
      {
        projectId: "projA",
        level: 1,
        usage: {
          inputTokens: 1,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 1,
        },
      },
      "2026-07-11T00:00:00.000Z",
    );
    const byForced = await store.aggregateUsageBySemanticForced("projA");
    expect(byForced.forced.requests).toBe(0);
    expect(byForced.notForced.requests).toBe(1);
    await store.close();
  });

  it("returns empty buckets when no telemetry file exists yet", async () => {
    const store = new JsonlTelemetryStore(dir);
    const byForced = await store.aggregateUsageBySemanticForced();
    expect(byForced.forced.requests).toBe(0);
    expect(byForced.notForced.requests).toBe(0);
    expect(byForced.projectId).toBeNull();
    await store.close();
  });
});

describe("recordAvoidedUpstream + aggregateAvoidedUpstream (R2.2, §62)", () => {
  it("rolls up input tokens avoided across avoidedUpstream events", async () => {
    const store = new JsonlTelemetryStore(dir);
    await recordAvoidedUpstream(store, "projA", "2026-07-11T00:00:00.000Z", 300);
    await recordAvoidedUpstream(store, "projA", "2026-07-11T00:00:01.000Z", 150);

    const stats = await store.aggregateAvoidedUpstream("projA");
    expect(stats.events).toBe(2);
    expect(stats.inputTokensAvoided).toBe(450);
    expect(stats.projectId).toBe("projA");
    await store.close();
  });

  it("rolls up output tokens avoided by the R2.3 local-answer sub-mode", async () => {
    const store = new JsonlTelemetryStore(dir);
    await recordAvoidedUpstream(store, "projA", "2026-07-11T00:00:00.000Z", 300, 120);
    await recordAvoidedUpstream(store, "projA", "2026-07-11T00:00:01.000Z", 150, 40);

    const stats = await store.aggregateAvoidedUpstream("projA");
    expect(stats.events).toBe(2);
    expect(stats.inputTokensAvoided).toBe(450);
    expect(stats.outputTokensAvoided).toBe(160);
    await store.close();
  });

  it("scopes by projectId, and the global view sees all projects", async () => {
    const store = new JsonlTelemetryStore(dir);
    await recordAvoidedUpstream(store, "projA", "2026-07-11T00:00:00.000Z", 100);
    await recordAvoidedUpstream(store, "projB", "2026-07-11T00:00:00.000Z", 200);

    expect((await store.aggregateAvoidedUpstream("projA")).inputTokensAvoided).toBe(100);
    expect((await store.aggregateAvoidedUpstream("projB")).inputTokensAvoided).toBe(200);
    const global = await store.aggregateAvoidedUpstream();
    expect(global.inputTokensAvoided).toBe(300);
    expect(global.events).toBe(2);
    expect(global.projectId).toBeNull();
    await store.close();
  });

  it("does not count toward aggregate()'s gross request/token headline", async () => {
    const store = new JsonlTelemetryStore(dir);
    await recordPipelineEvent(
      store,
      {
        projectId: "projA",
        level: 2,
        requestTokens: { tokensBefore: 1000, tokensAfter: 400 },
        stageSavings: {},
        ccrRefsStored: 0,
        avoidedUpstreamInputTokens: 0,
        avoidedUpstreamOutputTokens: 0,
      },
      "2026-07-11T00:00:00.000Z",
    );
    await recordAvoidedUpstream(store, "projA", "2026-07-11T00:00:01.000Z", 500);

    const stats = await store.aggregate("projA");
    expect(stats.requests).toBe(1);
    expect(stats.tokensBefore).toBe(1000);
    expect(stats.tokensAfter).toBe(400);
    await store.close();
  });

  it("returns empty buckets when no telemetry file exists yet", async () => {
    const store = new JsonlTelemetryStore(dir);
    const stats = await store.aggregateAvoidedUpstream();
    expect(stats.events).toBe(0);
    expect(stats.inputTokensAvoided).toBe(0);
    expect(stats.projectId).toBeNull();
    await store.close();
  });

  it("old lines without kind/avoidedUpstreamInputTokens still parse and are ignored", async () => {
    const store = new JsonlTelemetryStore(dir);
    await store.record(ev()); // predates avoidedUpstream entirely
    const stats = await store.aggregateAvoidedUpstream();
    expect(stats.events).toBe(0);
    expect(stats.inputTokensAvoided).toBe(0);
    await store.close();
  });
});

describe("recordToolCall + aggregateToolUsage (R4.3, §59)", () => {
  it("rolls up per-tool call counts, duration, result bytes, and draft chars", async () => {
    const store = new JsonlTelemetryStore(dir);
    await recordToolCall(
      store,
      { projectId: "projA", tool: "search", durationMs: 12, resultBytes: 400 },
      "2026-07-16T00:00:00.000Z",
    );
    await recordToolCall(
      store,
      { projectId: "projA", tool: "search", durationMs: 8, resultBytes: 200 },
      "2026-07-16T00:00:01.000Z",
    );
    await recordToolCall(
      store,
      {
        projectId: "projA",
        tool: "coder",
        durationMs: 900,
        resultBytes: 1500,
        model: "qwen2.5-coder:7b",
        draftChars: 1200,
      },
      "2026-07-16T00:00:02.000Z",
    );

    const stats = await store.aggregateToolUsage("projA");
    expect(stats.byTool.search).toStrictEqual({
      calls: 2,
      totalDurationMs: 20,
      totalResultBytes: 600,
      draftChars: 0,
    });
    expect(stats.byTool.coder).toStrictEqual({
      calls: 1,
      totalDurationMs: 900,
      totalResultBytes: 1500,
      draftChars: 1200,
    });
    await store.close();
  });

  it("tool events never count as pipeline requests or gross-token savings", async () => {
    const store = new JsonlTelemetryStore(dir);
    await recordToolCall(
      store,
      { projectId: "projA", tool: "coder", durationMs: 5, resultBytes: 10, draftChars: 7 },
      "2026-07-16T00:00:00.000Z",
    );
    const agg = await store.aggregate("projA");
    expect(agg.requests).toBe(0);
    expect(agg.tokensBefore).toBe(0);
    await store.close();
  });

  it("scopes by project and returns an empty map when no file exists yet", async () => {
    const store = new JsonlTelemetryStore(dir);
    expect((await store.aggregateToolUsage()).byTool).toStrictEqual({});
    await recordToolCall(
      store,
      { projectId: "projA", tool: "fetch", durationMs: 3, resultBytes: 50 },
      "2026-07-16T00:00:00.000Z",
    );
    await recordToolCall(
      store,
      { projectId: "projB", tool: "fetch", durationMs: 4, resultBytes: 60 },
      "2026-07-16T00:00:01.000Z",
    );
    expect(Object.keys((await store.aggregateToolUsage("projA")).byTool)).toStrictEqual(["fetch"]);
    expect((await store.aggregateToolUsage("projA")).byTool.fetch?.calls).toBe(1);
    expect((await store.aggregateToolUsage()).byTool.fetch?.calls).toBe(2);
    await store.close();
  });
});
