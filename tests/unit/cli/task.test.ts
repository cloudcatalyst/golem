/**
 * R5.1 — `golem task` CLI helpers: id resolution + rendering.
 */

import { describe, expect, it } from "vitest";
import {
  findScopedTask,
  findTask,
  renderScopedTaskList,
  renderTask,
  renderTaskList,
  type ScopedTask,
  taskTitle,
} from "../../../src/cli/task.js";
import { createTask, parsePlanTask, type Task } from "../../../src/tasks/index.js";

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

/**
 * Two scopes, one CLI (Decision 55). The properties that matter: an exact id wins over
 * a prefix (plan ids are short, so `R8.5` must not be ambiguous against `R8.50`), and a
 * resolution carries its scope so a mutation writes back to the right store.
 */
describe("findScopedTask", () => {
  const plan = parsePlanTask("---\ntask: R8.5\ntitle: Repo map\n---\n\nbody text here\n");
  const plan2 = parsePlanTask("---\ntask: R8.50\ntitle: Other\n---\n\nbody text here\n");
  const entries: ScopedTask[] = [
    { task: plan, scope: "plan" },
    { task: plan2, scope: "plan" },
    { task: A, scope: "local" },
  ];

  it("keeps the scope of whatever it resolved", () => {
    const found = findScopedTask(entries, "R8.5");
    expect(found).not.toBe("none");
    if (found === "none" || found === "ambiguous") throw new Error("expected a task");
    expect(found.scope).toBe("plan");
    expect(findScopedTask(entries, "aaaa1111")).toMatchObject({ scope: "local" });
  });

  it("prefers an exact id over a prefix match", () => {
    // Prefix-only resolution would call `R8.5` ambiguous against `R8.50` and refuse a
    // perfectly unambiguous id.
    expect(findScopedTask(entries, "R8.5")).toMatchObject({ task: { id: "R8.5" } });
    expect(findScopedTask(entries, "R8.50")).toMatchObject({ task: { id: "R8.50" } });
  });

  it("is case-insensitive on the exact match", () => {
    expect(findScopedTask(entries, "r8.5")).toMatchObject({ task: { id: "R8.5" } });
  });

  it("still resolves a unique prefix, and reports none / ambiguous otherwise", () => {
    expect(findScopedTask(entries, "aaaa")).toMatchObject({ scope: "local" });
    expect(findScopedTask(entries, "nope")).toBe("none");
    expect(findScopedTask(entries, "R8.")).toBe("ambiguous");
  });
});

describe("renderScopedTaskList", () => {
  const plan = parsePlanTask(
    "---\ntask: R7.5\ntitle: Publish\nowner: user\nsize: M\nblocked: needs creds\n---\n\nbody\n",
  );

  it("groups by scope, plan first, and names each home", () => {
    const out = renderScopedTaskList([
      { task: A, scope: "local" },
      { task: plan, scope: "plan" },
    ]);
    expect(out.indexOf("plan (committed")).toBeLessThan(out.indexOf("local (this machine"));
    expect(out).toContain("docs/plan/tasks/");
    expect(out).toContain(".golem/tasks/");
  });

  it("prints a plan id in full and a local id truncated", () => {
    const out = renderScopedTaskList([
      { task: A, scope: "local" },
      { task: plan, scope: "plan" },
    ]);
    expect(out).toContain("R7.5");
    expect(out).toContain("aaaa1111");
  });

  it("surfaces owner, size and the blocker", () => {
    const out = renderScopedTaskList([{ task: plan, scope: "plan" }]);
    expect(out).toContain("user");
    expect(out).toContain("[blocked: needs creds]");
  });

  it("points at both entry points when there is nothing at all", () => {
    const out = renderScopedTaskList([]);
    expect(out).toContain("golem task index");
    expect(out).toContain("golem task add");
  });

  it("omits a scope's heading entirely when it is empty", () => {
    expect(renderScopedTaskList([{ task: A, scope: "local" }])).not.toContain("plan (committed");
  });
});
