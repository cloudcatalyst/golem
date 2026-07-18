/**
 * Golem snooze core wait logic (src/mcp/snooze.ts) — the timing/heartbeat/abort
 * behavior the `snooze` MCP tool wraps. Driven with an injected clock, an
 * instant fake sleep, and a heartbeat spy so it is deterministic and fast.
 */

import { describe, expect, it, vi } from "vitest";
import {
  abortableSleep,
  DEFAULT_SNOOZE_MAX_MS,
  resolveSnoozeTargetMs,
  runSnooze,
  type SnoozeDeps,
  SnoozeInputError,
} from "../../../src/mcp/snooze.js";

const NOW = Date.parse("2026-07-18T00:00:00.000Z");

/** Deps with an instant sleep, a fixed clock, and a counting heartbeat. */
function fakeDeps(over: Partial<SnoozeDeps> = {}): SnoozeDeps {
  return {
    now: () => NOW,
    sleep: () => Promise.resolve(),
    heartbeat: () => {},
    ...over,
  };
}

describe("resolveSnoozeTargetMs", () => {
  it("computes ms until a future `until`", () => {
    expect(resolveSnoozeTargetMs({ until: "2026-07-18T01:00:00.000Z" }, NOW)).toBe(3_600_000);
  });
  it("clamps a past `until` to 0 (already reset)", () => {
    expect(resolveSnoozeTargetMs({ until: "2026-07-17T23:00:00.000Z" }, NOW)).toBe(0);
  });
  it("uses `durationMs` when given", () => {
    expect(resolveSnoozeTargetMs({ durationMs: 45_000 }, NOW)).toBe(45_000);
  });
  it("throws when neither target is given", () => {
    expect(() => resolveSnoozeTargetMs({}, NOW)).toThrow(SnoozeInputError);
  });
  it("throws on an unparseable `until`", () => {
    expect(() => resolveSnoozeTargetMs({ until: "not-a-date" }, NOW)).toThrow(SnoozeInputError);
  });
});

describe("runSnooze", () => {
  it("waits the full target and heartbeats between chunks (not after the last)", async () => {
    const heartbeat = vi.fn();
    const out = await runSnooze(
      { durationMs: 180_000 },
      fakeDeps({ heartbeat, heartbeatMs: 60_000 }),
    );
    expect(out.reset).toBe(true);
    expect(out.waitedMs).toBe(180_000);
    expect(out.targetMs).toBe(180_000);
    // chunks at 60k/120k/180k → heartbeat after the first two, not the final.
    expect(out.heartbeats).toBe(2);
    expect(heartbeat).toHaveBeenCalledTimes(2);
  });

  it("returns immediately (no wait) when the reset is already in the past", async () => {
    const heartbeat = vi.fn();
    const out = await runSnooze({ until: "2026-07-17T23:00:00.000Z" }, fakeDeps({ heartbeat }));
    expect(out.reset).toBe(true);
    expect(out.waitedMs).toBe(0);
    expect(out.heartbeats).toBe(0);
    expect(heartbeat).not.toHaveBeenCalled();
  });

  it("declines (does not wait) when the reset is beyond the cap", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const out = await runSnooze({ durationMs: DEFAULT_SNOOZE_MAX_MS + 1 }, fakeDeps({ sleep }));
    expect(out.reset).toBe(false);
    expect(out.waitedMs).toBe(0);
    expect(out.reason).toMatch(/beyond/i);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("honors a pre-aborted signal without waiting", async () => {
    const controller = new AbortController();
    controller.abort();
    const sleep = vi.fn(() => Promise.resolve());
    const out = await runSnooze(
      { durationMs: 180_000 },
      fakeDeps({ signal: controller.signal, sleep, heartbeatMs: 60_000 }),
    );
    expect(out.reset).toBe(false);
    expect(out.reason).toBe("cancelled");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops early when aborted mid-wait", async () => {
    const controller = new AbortController();
    let calls = 0;
    const sleep = (): Promise<void> => {
      calls += 1;
      if (calls === 2) controller.abort(); // abort during the second chunk
      return Promise.resolve();
    };
    const out = await runSnooze(
      { durationMs: 180_000 },
      fakeDeps({ signal: controller.signal, sleep, heartbeatMs: 60_000 }),
    );
    expect(out.reset).toBe(false);
    expect(out.reason).toBe("cancelled");
    expect(out.waitedMs).toBe(60_000); // completed one chunk before the abort
  });

  it("swallows a throwing heartbeat and keeps waiting (idle-timeout config is the fallback)", async () => {
    const heartbeat = vi.fn(() => {
      throw new Error("no progress token");
    });
    const out = await runSnooze(
      { durationMs: 120_000 },
      fakeDeps({ heartbeat, heartbeatMs: 60_000 }),
    );
    expect(out.reset).toBe(true);
    expect(out.waitedMs).toBe(120_000);
    expect(out.heartbeats).toBe(0); // attempted but threw → not counted
    expect(heartbeat).toHaveBeenCalledTimes(1); // one inter-chunk boundary
  });
});

describe("abortableSleep", () => {
  it("resolves after the delay", async () => {
    await expect(abortableSleep(10)).resolves.toBeUndefined();
  });
  it("resolves promptly when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableSleep(10_000, controller.signal)).resolves.toBeUndefined();
  });
  it("resolves when aborted mid-sleep", async () => {
    const controller = new AbortController();
    const p = abortableSleep(10_000, controller.signal);
    controller.abort();
    await expect(p).resolves.toBeUndefined();
  });
});
