/**
 * R5.1 — durable task shape: defaults, validation, resumability gate.
 */

import { describe, expect, it } from "vitest";
import { createTask, isResumable, type Task, taskSchema } from "../../../src/tasks/index.js";

describe("createTask", () => {
  it("builds a queued task with timestamps and defaults", () => {
    const t = createTask({ prompt: "do the thing" }, "2026-07-16T00:00:00.000Z", "abc");
    expect(t.id).toBe("abc");
    expect(t.state).toBe("queued");
    expect(t.createdAt).toBe("2026-07-16T00:00:00.000Z");
    expect(t.updatedAt).toBe("2026-07-16T00:00:00.000Z");
    expect(t.continueLatest).toBe(false);
    expect(t.checkpoints).toEqual([]);
    expect(t.attempts).toBe(0);
  });

  it("carries optional fields through", () => {
    const t = createTask({
      prompt: "p",
      title: "T",
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      agentType: "general-purpose",
      idempotencyKey: "pr-42",
      notBefore: "2026-07-17T00:00:00.000Z",
    });
    expect(t.title).toBe("T");
    expect(t.sessionId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(t.agentType).toBe("general-purpose");
    expect(t.idempotencyKey).toBe("pr-42");
    expect(t.notBefore).toBe("2026-07-17T00:00:00.000Z");
  });

  it("produces a task that round-trips through the schema", () => {
    const t = createTask({ prompt: "p" });
    expect(() => taskSchema.parse(t)).not.toThrow();
  });
});

describe("isResumable", () => {
  const base: Task = createTask({ prompt: "p" }, "2026-07-16T00:00:00.000Z", "id");

  it("is true for a queued task with no capacity gate", () => {
    expect(isResumable(base)).toBe(true);
  });

  it("is false for terminal states", () => {
    for (const state of ["done", "failed", "cancelled"] as const) {
      expect(isResumable({ ...base, state })).toBe(false);
    }
  });

  it("respects the notBefore capacity gate", () => {
    const now = Date.parse("2026-07-16T12:00:00.000Z");
    expect(isResumable({ ...base, notBefore: "2026-07-16T18:00:00.000Z" }, now)).toBe(false);
    expect(isResumable({ ...base, notBefore: "2026-07-16T06:00:00.000Z" }, now)).toBe(true);
  });
});
