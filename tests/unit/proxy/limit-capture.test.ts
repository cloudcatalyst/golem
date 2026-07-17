/**
 * Auto-resume Phase 1 — limit capture: always log, capture a durable resume
 * task only for a real (non-transient) exhaustion; idempotent per window;
 * respects a user-cancelled task.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureLimit, type LimitCaptureDeps } from "../../../src/proxy/limit-capture.js";
import type { UsageLimitSignal } from "../../../src/proxy/limit-detector.js";
import { FileTaskStore } from "../../../src/tasks/index.js";

const NOW = Date.parse("2026-07-17T12:00:00.000Z");

function signal(overrides: Partial<UsageLimitSignal> = {}): UsageLimitSignal {
  return {
    statusCode: 429,
    resetAtIso: "2026-07-17T17:00:00.000Z", // 5h out — real exhaustion
    secondsUntilReset: 5 * 3600,
    retryAfter: null,
    resetSource: "anthropic-ratelimit-tokens-reset",
    headers: { "anthropic-ratelimit-tokens-reset": "2026-07-17T17:00:00.000Z" },
    ...overrides,
  };
}

describe("captureLimit (auto-resume Phase 1)", () => {
  let dir: string;
  let logged: Array<Record<string, unknown>>;
  let store: FileTaskStore;

  function deps(over: Partial<LimitCaptureDeps> = {}): LimitCaptureDeps {
    return {
      store,
      sessionId: () => Promise.resolve("sess-abc"),
      log: (e) => {
        logged.push(e);
        return Promise.resolve();
      },
      now: () => NOW,
      ...over,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-limit-"));
    logged = [];
    store = new FileTaskStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("always logs the signal", async () => {
    await captureLimit(signal({ secondsUntilReset: 5, resetAtIso: null }), deps());
    expect(logged).toHaveLength(1);
    expect(logged[0]?.status).toBe(429);
  });

  it("captures a durable task gated to the reset time for a real exhaustion", async () => {
    const out = await captureLimit(signal(), deps());
    expect(out.captured).toBe(true);
    const tasks = await store.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.notBefore).toBe("2026-07-17T17:00:00.000Z");
    expect(tasks[0]?.sessionId).toBe("sess-abc");
    expect(tasks[0]?.state).toBe("queued");
  });

  it("does NOT capture a transient per-minute 429 (below threshold)", async () => {
    const out = await captureLimit(signal({ secondsUntilReset: 30 }), deps());
    expect(out.captured).toBe(false);
    expect(await store.list()).toHaveLength(0);
    expect(logged).toHaveLength(1); // still logged
  });

  it("does NOT capture when the reset is unknown", async () => {
    const out = await captureLimit(signal({ resetAtIso: null, secondsUntilReset: null }), deps());
    expect(out.captured).toBe(false);
    expect(await store.list()).toHaveLength(0);
  });

  it("is idempotent per (session, window): repeated 429s update ONE task", async () => {
    const a = await captureLimit(signal(), deps());
    const b = await captureLimit(signal(), deps());
    expect(a.taskId).toBe(b.taskId);
    expect(await store.list()).toHaveLength(1);
  });

  it("does not resurrect a task the user already cancelled for this window", async () => {
    const first = await captureLimit(signal(), deps());
    const task = await store.get(first.taskId as string);
    await store.put({ ...(task as NonNullable<typeof task>), state: "cancelled" });
    const again = await captureLimit(signal(), deps());
    expect(again.captured).toBe(false);
    expect((await store.get(first.taskId as string))?.state).toBe("cancelled");
  });

  it("falls back to continueLatest when no session id is known", async () => {
    const out = await captureLimit(signal(), deps({ sessionId: () => Promise.resolve(undefined) }));
    const task = await store.get(out.taskId as string);
    expect(task?.sessionId).toBeUndefined();
    expect(task?.continueLatest).toBe(true);
  });
});
