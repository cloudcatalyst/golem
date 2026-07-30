/**
 * Limit prediction (snooze P2a, src/proxy/limit-prediction.ts): parsing the
 * `anthropic-ratelimit-unified-*` response headers and the state round-trip.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type LimitPrediction,
  limitStatePath,
  parseLimitPrediction,
  readLimitState,
  writeLimitState,
} from "../../../src/proxy/limit-prediction.js";
import { rmTemp } from "../../helpers/tmp.js";

const NOW_ISO = "2026-07-18T00:00:00.000Z";

// Real header values (see .golem/state limit-hits sample): reset is unix epoch seconds.
const FULL = {
  "anthropic-ratelimit-unified-5h-utilization": "0.95",
  "anthropic-ratelimit-unified-5h-reset": "1784286600",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-7d-utilization": "0.64",
  "anthropic-ratelimit-unified-7d-reset": "1784710800",
  "anthropic-ratelimit-unified-7d-status": "allowed",
} as const;

describe("parseLimitPrediction", () => {
  it("parses both windows, converting epoch-second resets to ISO", () => {
    const p = parseLimitPrediction(FULL, NOW_ISO);
    expect(p).not.toBeNull();
    expect(p?.observedAtIso).toBe(NOW_ISO);
    expect(p?.fiveHour.utilization).toBe(0.95);
    expect(p?.fiveHour.resetAtIso).toBe(new Date(1784286600 * 1000).toISOString());
    expect(p?.fiveHour.status).toBe("allowed");
    expect(p?.sevenDay?.utilization).toBe(0.64);
    expect(p?.sevenDay?.resetAtIso).toBe(new Date(1784710800 * 1000).toISOString());
  });

  it("returns a 5h-only prediction when weekly headers are absent", () => {
    const p = parseLimitPrediction(
      {
        "anthropic-ratelimit-unified-5h-utilization": "0.5",
        "anthropic-ratelimit-unified-5h-reset": "1784286600",
      },
      NOW_ISO,
    );
    expect(p?.fiveHour.utilization).toBe(0.5);
    expect(p?.fiveHour.status).toBeUndefined();
    expect(p?.sevenDay).toBeUndefined();
  });

  it("returns null when the session-window utilization header is absent", () => {
    expect(parseLimitPrediction({ "x-request-id": "abc" }, NOW_ISO)).toBeNull();
    expect(
      parseLimitPrediction({ "anthropic-ratelimit-unified-5h-reset": "1784286600" }, NOW_ISO),
    ).toBeNull();
  });

  it("null reset when the reset header is missing or unparseable", () => {
    const p = parseLimitPrediction(
      { "anthropic-ratelimit-unified-5h-utilization": "1.0" },
      NOW_ISO,
    );
    expect(p?.fiveHour.resetAtIso).toBeNull();
  });

  it("uses the first value of an array-valued header", () => {
    const p = parseLimitPrediction(
      { "anthropic-ratelimit-unified-5h-utilization": ["0.42", "9.9"] },
      NOW_ISO,
    );
    expect(p?.fiveHour.utilization).toBe(0.42);
  });

  it("treats a non-numeric utilization as absent (→ null)", () => {
    expect(
      parseLimitPrediction({ "anthropic-ratelimit-unified-5h-utilization": "n/a" }, NOW_ISO),
    ).toBeNull();
  });
});

describe("limit state round-trip", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-limit-"));
  });
  afterEach(async () => {
    await rm(dir, rmTemp);
  });

  it("writes then reads back an equal prediction", async () => {
    const p = parseLimitPrediction(FULL, NOW_ISO) as LimitPrediction;
    await writeLimitState(dir, p);
    expect(await readLimitState(dir)).toStrictEqual(p);
  });

  it("returns null when no state has been written", async () => {
    expect(await readLimitState(dir)).toBeNull();
  });

  it("returns null on a corrupt state file", async () => {
    await mkdir(path.dirname(limitStatePath(dir)), { recursive: true });
    await writeFile(limitStatePath(dir), "{ not json", "utf8");
    expect(await readLimitState(dir)).toBeNull();
  });
});
