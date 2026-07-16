/**
 * R5.1 — `golem task` CLI helpers: id resolution + rendering.
 */

import { describe, expect, it } from "vitest";
import { findTask, renderTask, renderTaskList, taskTitle } from "../../../src/cli/task.js";
import { createTask, type Task } from "../../../src/tasks/index.js";

const A = createTask({ prompt: "alpha task" }, "2026-07-16T00:00:00.000Z", "aaaa1111");
const B = createTask({ prompt: "beta task" }, "2026-07-16T01:00:00.000Z", "bbbb2222");

describe("findTask", () => {
  it("matches an exact id", () => {
    expect(findTask([A, B], "aaaa1111")).toBe(A);
  });
  it("matches a unique prefix", () => {
    expect(findTask([A, B], "bbbb")).toBe(B);
  });
  it("reports none / ambiguous", () => {
    expect(findTask([A, B], "zzzz")).toBe("none");
    const twins = [
      createTask({ prompt: "x" }, undefined, "dup-1"),
      createTask({ prompt: "y" }, undefined, "dup-2"),
    ] as Task[];
    expect(findTask(twins, "dup")).toBe("ambiguous");
  });
});

describe("taskTitle", () => {
  it("prefers an explicit title, else the prompt's first line", () => {
    expect(taskTitle(createTask({ prompt: "p", title: "Explicit" }))).toBe("Explicit");
    expect(taskTitle(createTask({ prompt: "first line\nsecond" }))).toBe("first line");
  });
  it("truncates a very long prompt", () => {
    const long = "x".repeat(100);
    expect(taskTitle(createTask({ prompt: long })).endsWith("…")).toBe(true);
  });
});

describe("renderTaskList", () => {
  it("shows an empty hint", () => {
    expect(renderTaskList([])).toContain("no tasks");
  });
  it("lists newest-updated first with short ids and state", () => {
    const out = renderTaskList([A, B]);
    expect(out.indexOf("bbbb2222")).toBeLessThan(out.indexOf("aaaa1111")); // B updated later
    expect(out).toContain("queued");
    expect(out).toContain("alpha task");
  });
});

describe("renderTask", () => {
  it("shows the detailed fields and prompt", () => {
    const t = createTask({ prompt: "line one\nline two", sessionId: "sess-9", title: "My task" });
    const out = renderTask(t);
    expect(out).toContain("state:      queued");
    expect(out).toContain("session:    sess-9");
    expect(out).toContain("My task");
    expect(out).toContain("line one");
    expect(out).toContain("line two");
  });
});
