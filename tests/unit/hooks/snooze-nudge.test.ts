/**
 * Snooze document-and-hold trigger (snooze P2b, src/hooks/snooze-nudge.ts):
 * the nudge decision, the reason text, and the one-shot state round-trip.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decideSnoozeNudge,
  readSnoozeNudgeState,
  STALE_AFTER_MS,
  snoozeEnforceReason,
  snoozeNudgeReason,
  snoozeNudgeStatePath,
  snoozeStaleReason,
  writeSnoozeNudgeState,
} from "../../../src/hooks/snooze-nudge.js";
import type { LimitPrediction } from "../../../src/proxy/limit-prediction.js";
import { rmTemp } from "../../helpers/tmp.js";

const NOW_MS = Date.parse("2026-07-18T00:00:00.000Z");
const FUTURE = "2026-07-18T02:00:00.000Z";
const PAST = "2026-07-17T22:00:00.000Z";

/** A FRESH prediction: observed "now" so it never trips the staleness guard. */
function prediction(utilization: number, resetAtIso: string | null): LimitPrediction {
  return { observedAtIso: "2026-07-18T00:00:00.000Z", fiveHour: { utilization, resetAtIso } };
}

describe("decideSnoozeNudge", () => {
  it("parks when near-limit with a future reset, not yet nudged", () => {
    const d = decideSnoozeNudge(prediction(0.95, FUTURE), {}, NOW_MS);
    expect(d).toStrictEqual({ kind: "park", resetAtIso: FUTURE, utilization: 0.95 });
  });

  it("does not park below the threshold", () => {
    expect(decideSnoozeNudge(prediction(0.5, FUTURE), {}, NOW_MS).kind).toBe("none");
  });

  it("stays silent on a null prediction (never seen headers)", () => {
    expect(decideSnoozeNudge(null, {}, NOW_MS).kind).toBe("none");
  });

  it("does not park when the reset is already past", () => {
    expect(decideSnoozeNudge(prediction(0.99, PAST), {}, NOW_MS).kind).toBe("none");
  });

  it("does not park when there is no reset time", () => {
    expect(decideSnoozeNudge(prediction(0.99, null), {}, NOW_MS).kind).toBe("none");
  });

  it("is one-shot: no park when already nudged for this exact reset window", () => {
    expect(
      decideSnoozeNudge(prediction(0.99, FUTURE), { nudgedForResetIso: FUTURE }, NOW_MS).kind,
    ).toBe("none");
    // A NEW window (different reset) parks again.
    expect(
      decideSnoozeNudge(prediction(0.99, FUTURE), { nudgedForResetIso: PAST }, NOW_MS).kind,
    ).toBe("park");
  });

  it("honors a custom threshold", () => {
    expect(decideSnoozeNudge(prediction(0.85, FUTURE), {}, NOW_MS, 0.8).kind).toBe("park");
    expect(decideSnoozeNudge(prediction(0.75, FUTURE), {}, NOW_MS, 0.8).kind).toBe("none");
  });

  describe("staleness (feed gone cold — e.g. account switch)", () => {
    // A reading observed well over the stale window ago, with a still-future reset
    // and high utilization: the OLD logic would have parked on stale data; the new
    // logic flags it stale instead.
    const staleObserved = new Date(NOW_MS - (STALE_AFTER_MS + 60_000)).toISOString();
    const stale = (): LimitPrediction => ({
      observedAtIso: staleObserved,
      fiveHour: { utilization: 0.17, resetAtIso: FUTURE },
    });

    it("flags a stale reading rather than silently returning none", () => {
      const d = decideSnoozeNudge(stale(), {}, NOW_MS);
      expect(d.kind).toBe("stale");
      if (d.kind !== "stale") throw new Error("expected stale");
      expect(d.observedAtIso).toBe(staleObserved);
      expect(d.utilization).toBe(0.17);
      expect(d.ageMinutes).toBeGreaterThanOrEqual(31);
    });

    it("staleness takes precedence over a park (never park on stale data)", () => {
      // High utilization but stale → stale, NOT park.
      const d = decideSnoozeNudge(
        { observedAtIso: staleObserved, fiveHour: { utilization: 0.99, resetAtIso: FUTURE } },
        {},
        NOW_MS,
      );
      expect(d.kind).toBe("stale");
    });

    it("is one-shot per stale reading (warn once for the same observedAt)", () => {
      expect(
        decideSnoozeNudge(stale(), { staleWarnedForObservedIso: staleObserved }, NOW_MS).kind,
      ).toBe("none");
    });

    it("a fresh reading (within the window) is not stale", () => {
      expect(decideSnoozeNudge(prediction(0.17, FUTURE), {}, NOW_MS).kind).toBe("none");
    });

    it("enforce never overrides staleness — a cold feed still only warns", () => {
      const d = decideSnoozeNudge(stale(), {}, NOW_MS, undefined, undefined, true);
      expect(d.kind).toBe("stale");
    });
  });

  describe("enforce mode (persistent deny)", () => {
    it("bypasses the one-shot: parks even when already nudged for this window", () => {
      // Advisory returns none (one-shot consumed for this reset)...
      expect(
        decideSnoozeNudge(prediction(0.95, FUTURE), { nudgedForResetIso: FUTURE }, NOW_MS).kind,
      ).toBe("none");
      // ...but enforce keeps parking so the caller can deny persistently.
      expect(
        decideSnoozeNudge(
          prediction(0.95, FUTURE),
          { nudgedForResetIso: FUTURE },
          NOW_MS,
          undefined,
          undefined,
          true,
        ).kind,
      ).toBe("park");
    });

    it("still respects the threshold and future-reset guards", () => {
      const opts = [undefined, undefined, true] as const;
      expect(decideSnoozeNudge(prediction(0.5, FUTURE), {}, NOW_MS, ...opts).kind).toBe("none");
      expect(decideSnoozeNudge(prediction(0.99, PAST), {}, NOW_MS, ...opts).kind).toBe("none");
    });
  });
});

describe("snoozeNudgeReason", () => {
  it("instructs the document-and-hold pattern with the rounded utilization and reset", () => {
    const r = snoozeNudgeReason(FUTURE, 0.937);
    expect(r).toContain("94%");
    expect(r).toContain("mcp__golem__snooze");
    expect(r).toContain(`until="${FUTURE}"`);
    expect(r).toContain("STOP");
  });

  // Task `snooze-taskadd`: the documenting step is snooze's own `note`, never a
  // separate `golem task add` — enforcement denies that Bash call (§105).
  it("asks for the note on the snooze call, not a separate task-add command", () => {
    const r = snoozeNudgeReason(FUTURE, 0.937);
    expect(r).toContain("note=");
    expect(r).not.toContain("golem task add");
  });
});

describe("snoozeStaleReason", () => {
  it("explains the feed is blind and names the likely account-switch cause", () => {
    const r = snoozeStaleReason("2026-07-18T00:00:00.000Z", 0.17, 45);
    expect(r).toContain("BLIND");
    expect(r).toContain("45 min");
    expect(r).toContain("17%");
    expect(r).toContain("account switch");
    expect(r).toContain("golem status");
  });
});

describe("snoozeEnforceReason", () => {
  it("states snooze is the only permitted action and how to lift enforcement", () => {
    const r = snoozeEnforceReason(FUTURE, 0.95);
    expect(r).toContain("ENFORCEMENT");
    expect(r).toContain("ONLY permitted action");
    expect(r).toContain("mcp__golem__snooze");
    expect(r).toContain(`until="${FUTURE}"`);
    expect(r).toContain("GOLEM_SNOOZE_ENFORCE=false");
  });

  // Task `snooze-taskadd`: enforcement denies `Bash`, so the enforce reason must
  // point at snooze's `note` and explicitly warn AGAINST trying `golem task add`.
  it("routes the documenting step through `note` and warns off `golem task add`", () => {
    const r = snoozeEnforceReason(FUTURE, 0.95);
    expect(r).toContain("note=");
    expect(r).toMatch(/do NOT try to run `golem task add`/);
  });
});

describe("snooze nudge state round-trip", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-nudge-"));
  });
  afterEach(async () => {
    await rm(dir, rmTemp);
  });

  it("writes then reads back both one-shot markers", async () => {
    await writeSnoozeNudgeState(dir, {
      nudgedForResetIso: FUTURE,
      staleWarnedForObservedIso: PAST,
    });
    expect(await readSnoozeNudgeState(dir)).toStrictEqual({
      nudgedForResetIso: FUTURE,
      staleWarnedForObservedIso: PAST,
    });
  });

  it("omits absent keys (partial state round-trips cleanly)", async () => {
    await writeSnoozeNudgeState(dir, { nudgedForResetIso: FUTURE });
    expect(await readSnoozeNudgeState(dir)).toStrictEqual({ nudgedForResetIso: FUTURE });
  });

  it("returns {} when nothing was written", async () => {
    expect(await readSnoozeNudgeState(dir)).toStrictEqual({});
  });

  it("returns {} on a corrupt state file", async () => {
    await mkdir(path.dirname(snoozeNudgeStatePath(dir)), { recursive: true });
    await writeFile(snoozeNudgeStatePath(dir), "{ not json", "utf8");
    expect(await readSnoozeNudgeState(dir)).toStrictEqual({});
  });
});
