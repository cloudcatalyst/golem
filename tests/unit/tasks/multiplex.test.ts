/**
 * R5.3 — local conversation multiplexing: service queued tasks, bounded
 * concurrency, graceful degradation, explicit escalation.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CapabilityUnavailableError,
  type ChatMessage,
  type ChatResult,
  type InferenceService,
  type Role,
} from "../../../src/interfaces/inference.js";
import {
  createTask,
  escalateTask,
  FileTaskStore,
  mapWithConcurrency,
  runQueueLocally,
  serviceTaskLocally,
} from "../../../src/tasks/index.js";

function fakeInference(overrides: Partial<InferenceService> = {}): InferenceService {
  return {
    chat: (role: Role, _m: readonly ChatMessage[]): Promise<ChatResult> =>
      Promise.resolve({
        text: "local draft",
        model: "qwen2.5-coder:7b",
        role,
        promptTokens: 1,
        completionTokens: 2,
        finishReason: "stop",
      }),
    embed: () => Promise.resolve([]),
    capabilities: () => 2,
    ...overrides,
  };
}

const unavailable = (): InferenceService =>
  fakeInference({
    chat: () => Promise.reject(new CapabilityUnavailableError("drafter", 2)),
  });

describe("serviceTaskLocally", () => {
  it("attaches the local result and marks the task done", async () => {
    const task = createTask({ prompt: "triage this" }, "2026-07-16T00:00:00.000Z", "t1");
    const out = await serviceTaskLocally(
      task,
      { inference: fakeInference() },
      "2026-07-16T01:00:00.000Z",
    );
    expect(out.state).toBe("done");
    expect(out.result).toBe("local draft");
    expect(out.checkpoints.at(-1)?.label).toContain("serviced locally");
  });

  it("injects grounding when provided", async () => {
    let seen = "";
    const inference = fakeInference({
      chat: (role, m) => {
        seen = String((m[1] as { content?: unknown }).content ?? "");
        return Promise.resolve({
          text: "ok",
          model: "m",
          role,
          promptTokens: 0,
          completionTokens: 0,
          finishReason: "stop",
        });
      },
    });
    const task = createTask({ prompt: "do X" });
    await serviceTaskLocally(task, { inference, ground: () => Promise.resolve("KB CONTEXT") });
    expect(seen).toContain("do X");
    expect(seen).toContain("KB CONTEXT");
  });

  it("fails OPEN when the local model is unavailable (stays queued + records error)", async () => {
    const task = createTask({ prompt: "p" }, undefined, "t2");
    const out = await serviceTaskLocally(task, { inference: unavailable() });
    expect(out.state).toBe("queued"); // unchanged — not lost
    expect(out.lastError).toContain("local model unavailable");
    expect(out.result).toBeUndefined();
  });
});

describe("mapWithConcurrency", () => {
  it("preserves order and respects the cap", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});

describe("runQueueLocally", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-mux-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("services all queued tasks and persists results", async () => {
    const store = new FileTaskStore(dir);
    await store.put(createTask({ prompt: "a" }, undefined, "a"));
    await store.put(createTask({ prompt: "b" }, undefined, "b"));
    // A non-queued task must be left alone.
    await store.put({ ...createTask({ prompt: "c" }, undefined, "c"), state: "done" });
    const res = await runQueueLocally(store, { inference: fakeInference() }, { concurrency: 2 });
    expect(res.serviced).toBe(2);
    expect(res.total).toBe(2);
    expect((await store.get("a"))?.state).toBe("done");
    expect((await store.get("a"))?.result).toBe("local draft");
  });

  it("detects an unavailable model on the first task and leaves the rest queued", async () => {
    const store = new FileTaskStore(dir);
    await store.put(createTask({ prompt: "a" }, undefined, "a"));
    await store.put(createTask({ prompt: "b" }, undefined, "b"));
    const res = await runQueueLocally(store, { inference: unavailable() });
    expect(res.localModelUnavailable).toBe(true);
    expect(res.serviced).toBe(0);
    expect((await store.get("b"))?.state).toBe("queued"); // untouched
  });

  it("reports nothing to do on an empty queue", async () => {
    const res = await runQueueLocally(new FileTaskStore(dir), { inference: fakeInference() });
    expect(res.total).toBe(0);
  });
});

describe("escalateTask", () => {
  it("folds the local result + grounding into the prompt and marks escalated", () => {
    const task = { ...createTask({ prompt: "original" }, undefined, "e1"), result: "local pass" };
    const out = escalateTask(task, "KB grounding", "2026-07-16T00:00:00.000Z");
    expect(out.escalated).toBe(true);
    expect(out.state).toBe("queued");
    expect(out.prompt).toContain("original");
    expect(out.prompt).toContain("local pass");
    expect(out.prompt).toContain("KB grounding");
    expect(out.checkpoints.at(-1)?.label).toContain("escalated to Claude");
  });
});
