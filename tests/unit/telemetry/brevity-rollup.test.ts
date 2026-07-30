/**
 * Decision 52 — the brevity rollup and its report rows.
 *
 * The behaviours under test are the honesty ones: old events attribute to "off",
 * the two halves (billed output tokens, directive input cost) come from two
 * different event kinds, and no net saving is claimed without a real baseline.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { recordPipelineEvent, recordUsageEvent } from "../../../src/telemetry/index.js";
import { JsonlTelemetryStore, telemetryFilePath } from "../../../src/telemetry/jsonl-store.js";
import { brevityReportRows } from "../../../src/telemetry/usage-report.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "golem-brevity-"));
});

const USAGE = {
  inputTokens: 100,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 900,
  outputTokens: 1000,
};

describe("aggregateUsageByBrevity", () => {
  it("returns an empty rollup when nothing has been recorded", async () => {
    const store = new JsonlTelemetryStore(dir);
    await expect(store.aggregateUsageByBrevity()).resolves.toEqual({
      projectId: null,
      byBrevity: {},
    });
  });

  it("buckets billed output tokens by the brevity level tagged on the sample", async () => {
    const store = new JsonlTelemetryStore(dir);
    await recordUsageEvent(
      store,
      { projectId: "p", level: 2, usage: USAGE },
      "2026-07-30T00:00:00Z",
    );
    await recordUsageEvent(
      store,
      { projectId: "p", level: 2, usage: { ...USAGE, outputTokens: 400 }, brevity: "full" },
      "2026-07-30T00:01:00Z",
    );
    const rollup = await store.aggregateUsageByBrevity();
    expect(rollup.byBrevity.off?.requests).toBe(1);
    expect(rollup.byBrevity.off?.outputTokens).toBe(1000);
    expect(rollup.byBrevity.full?.requests).toBe(1);
    expect(rollup.byBrevity.full?.outputTokens).toBe(400);
  });

  it("attributes events written BEFORE the dial existed to 'off'", async () => {
    // Hand-write a line with no `brevity` field at all, exactly as a pre-
    // Decision-52 writer would have: brevity could not have been on, so the
    // sample must land in the "off" baseline rather than be dropped.
    const { mkdir } = await import("node:fs/promises");
    const file = telemetryFilePath(dir);
    await mkdir(path.dirname(file), { recursive: true });
    const legacy = {
      ts: "2026-07-01T00:00:00Z",
      projectId: "p",
      level: 1,
      kind: "usage",
      stageSavings: {},
      ccrRefsStored: 0,
      usage: USAGE,
    };
    await writeFile(file, `${JSON.stringify(legacy)}\n`, "utf8");

    const store = new JsonlTelemetryStore(dir);
    const rollup = await store.aggregateUsageByBrevity();
    expect(rollup.byBrevity.off?.requests).toBe(1);
    expect(Object.keys(rollup.byBrevity)).toEqual(["off"]);
  });

  it("accumulates the directive's input cost from PIPELINE events, separately", async () => {
    const store = new JsonlTelemetryStore(dir);
    await recordPipelineEvent(
      store,
      {
        projectId: "p",
        level: 2,
        requestTokens: { tokensBefore: 500, tokensAfter: 500 },
        stageSavings: {},
        ccrRefsStored: 0,
        avoidedUpstreamInputTokens: 0,
        avoidedUpstreamOutputTokens: 0,
        brevity: "lite",
        brevityDirectiveTokens: 120,
      },
      "2026-07-30T00:00:00Z",
    );
    const rollup = await store.aggregateUsageByBrevity();
    expect(rollup.byBrevity.lite?.directiveTokens).toBe(120);
    expect(rollup.byBrevity.lite?.injections).toBe(1);
    // No usage sample yet, so no billed output attributed.
    expect(rollup.byBrevity.lite?.requests).toBe(0);
    expect(rollup.byBrevity.lite?.outputTokens).toBe(0);
  });

  it("does not record a brevity tag on pipeline events when nothing was injected", async () => {
    const store = new JsonlTelemetryStore(dir);
    await recordPipelineEvent(
      store,
      {
        projectId: "p",
        level: 2,
        requestTokens: { tokensBefore: 500, tokensAfter: 400 },
        stageSavings: {},
        ccrRefsStored: 0,
        avoidedUpstreamInputTokens: 0,
        avoidedUpstreamOutputTokens: 0,
        brevity: "off",
        brevityDirectiveTokens: 0,
      },
      "2026-07-30T00:00:00Z",
    );
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(telemetryFilePath(dir), "utf8");
    // Pipeline-event bytes stay unchanged for the default (dial off) case.
    expect(raw).not.toContain("brevity");
  });

  it("scopes to a project id when given one", async () => {
    const store = new JsonlTelemetryStore(dir);
    await recordUsageEvent(
      store,
      { projectId: "a", level: 1, usage: USAGE, brevity: "lite" },
      "2026-07-30T00:00:00Z",
    );
    await recordUsageEvent(
      store,
      { projectId: "b", level: 1, usage: USAGE, brevity: "lite" },
      "2026-07-30T00:01:00Z",
    );
    const rollup = await store.aggregateUsageByBrevity("a");
    expect(rollup.projectId).toBe("a");
    expect(rollup.byBrevity.lite?.requests).toBe(1);
  });
});

describe("brevityReportRows", () => {
  it("claims NO net saving when there is no off baseline", () => {
    const rows = brevityReportRows({
      projectId: null,
      byBrevity: {
        full: {
          requests: 10,
          inputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 4000,
          directiveTokens: 1000,
          injections: 10,
        },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.netOutputEquivSavedPerRequest).toBeUndefined();
  });

  it("nets the saving against the baseline, charging the directive at 1/5 of output", () => {
    const rows = brevityReportRows({
      projectId: null,
      byBrevity: {
        off: {
          requests: 10,
          inputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 10_000, // 1000/req
          directiveTokens: 0,
          injections: 0,
        },
        full: {
          requests: 10,
          inputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 6_000, // 600/req → saves 400/req gross
          directiveTokens: 10_000, // 1000 input/req → 200 output-equiv/req
          injections: 10,
        },
      },
    });
    const full = rows.find((r) => r.brevity === "full");
    expect(full?.outputTokensPerRequest).toBe(600);
    expect(full?.directiveCostOutputEquivPerRequest).toBe(200);
    expect(full?.netOutputEquivSavedPerRequest).toBe(200); // 1000 - 600 - 200
    // The baseline is never a saving versus itself.
    expect(rows.find((r) => r.brevity === "off")?.netOutputEquivSavedPerRequest).toBeUndefined();
  });

  it("reports a NEGATIVE net when the directive costs more than it saves", () => {
    const rows = brevityReportRows({
      projectId: null,
      byBrevity: {
        off: {
          requests: 1,
          inputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 100,
          directiveTokens: 0,
          injections: 0,
        },
        lite: {
          requests: 1,
          inputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 95, // barely shorter — an already-terse workload
          directiveTokens: 1500, // 300 output-equiv
          injections: 1,
        },
      },
    });
    // Exactly the net-negative case the vendor's README warns about.
    expect(rows.find((r) => r.brevity === "lite")?.netOutputEquivSavedPerRequest).toBe(-295);
  });

  it("orders rows weakest-first regardless of insertion order", () => {
    const empty = {
      requests: 1,
      inputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 1,
      directiveTokens: 0,
      injections: 0,
    };
    const rows = brevityReportRows({
      projectId: null,
      byBrevity: { ultra: empty, off: empty, full: empty, lite: empty },
    });
    expect(rows.map((r) => r.brevity)).toEqual(["off", "lite", "full", "ultra"]);
  });
});
