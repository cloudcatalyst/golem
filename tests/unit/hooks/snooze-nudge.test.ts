/**
 * Snooze document-and-hold trigger (snooze P2b, src/hooks/snooze-nudge.ts):
 * the nudge decision, the reason text, and the one-shot state round-trip.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LimitPrediction } from "../../../src/proxy/limit-prediction.js";
import {
  decideSnoozeNudge,
  readSnoozeNudgeState,
  snoozeNudgeReason,
  snoozeNudgeStatePath,
  writeSnoozeNudgeState,
} from "../../../src/hooks/snooze-nudge.js";

const NOW_MS = Date.parse("2026-07-18T00:00:00.000Z");
const FUTURE = "2026-07-18T02:00:00.000Z";
const PAST = "2026-07-17T22:00:00.000Z";

function prediction(utilization: number, resetAtIso: string | null): LimitPrediction {
  return { observedAtIso: "2026-07-18T00:00:00.000Z", fiveHour: { utilization, resetAtIso } };
}

describe("decideSnoozeNudge", () => {
  it("nudges when near-limit with a future reset, not yet nudged", () => {
    const d = decideSnoozeNudge(prediction(0.95, FUTURE), undefined, NOW_MS);
    expect(d).toStrictEqual({ nudge: true, resetAtIso: FUTURE, utilization: 0.95 });
  });

  it("does not nudge below the threshold", () => {
    expect(decideSnoozeNudge(prediction(0.5, FUTURE), undefined, NOW_MS).nudge).toBe(false);
  });

  it("does not nudge on a null prediction", () => {
    expect(decideSnoozeNudge(null, undefined, NOW_MS).nudge).toBe(false);
  });

  it("does not nudge when the reset is already past", () => {
    expect(decideSnoozeNudge(prediction(0.99, PAST), undefined, NOW_MS).nudge).toBe(false);
  });

  it("does not nudge when there is no reset time", () => {
    expect(decideSnoozeNudge(prediction(0.99, null), undefined, NOW_MS).nudge).toBe(false);
  });

  it("is one-shot: no nudge when already nudged for this exact reset window", () => {
    expect(decideSnoozeNudge(prediction(0.99, FUTURE), FUTURE, NOW_MS).nudge).toBe(false);
    // A NEW window (different reset) nudges again.
    expect(decideSnoozeNudge(prediction(0.99, FUTURE), PAST, NOW_MS).nudge).toBe(true);
  });

  it("honors a custom threshold", () => {
    expect(decideSnoozeNudge(prediction(0.85, FUTURE), undefined, NOW_MS, 0.8).nudge).toBe(true);
    expect(decideSnoozeNudge(prediction(0.75, FUTURE), undefined, NOW_MS, 0.8).nudge).toBe(false);
  });
});

describe("snoozeNudgeReason", () => {
  it("instructs the document-and-hold pattern with the rounded utilization and reset", () => {
    const r = snoozeNudgeReason(FUTURE, 0.937);
    expect(r).toContain("94%");
    expect(r).toContain("golem task add");
    expect(r).toContain("mcp__golem__snooze");
    expect(r).toContain(`until="${FUTURE}"`);
    expect(r).toContain("STOP");
  });
});

describe("snooze nudge state round-trip", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-nudge-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes then reads back the nudged reset", async () => {
    await writeSnoozeNudgeState(dir, FUTURE);
    expect(await readSnoozeNudgeState(dir)).toBe(FUTURE);
  });

  it("returns undefined when nothing was written", async () => {
    expect(await readSnoozeNudgeState(dir)).toBeUndefined();
  });

  it("returns undefined on a corrupt state file", async () => {
    await mkdir(path.dirname(snoozeNudgeStatePath(dir)), { recursive: true });
    await writeFile(snoozeNudgeStatePath(dir), "{ not json", "utf8");
    expect(await readSnoozeNudgeState(dir)).toBeUndefined();
  });
});
