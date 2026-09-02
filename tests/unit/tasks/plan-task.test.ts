/**
 * Plan tasks — committed roadmap work as task documents.
 *
 * The load-bearing properties: the body round-trips as `Task.prompt` (that is what lets
 * every existing `golem task` surface work on a roadmap item), a malformed document is
 * skipped rather than taking the whole roadmap down with it, and an id can never escape
 * the tasks directory.
 */

import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  PlanTaskStore,
  parsePlanTask,
  planTaskSlug,
  planTasksDir,
  serializePlanTask,
} from "../../../src/tasks/index.js";
import { useTempDirs } from "../../helpers/tmp.js";

const DOC = `---
task: R8.5
title: Repo map
state: queued
owner: agent
size: L
design: proposals/r8-context-economy.md
gate: retrieval-accuracy harness
depends_on: [R8.4, R8.3]
touches: [src/knowledge/, src/mcp/]
created: 2026-07-30
updated: 2026-07-30
---

## Goal

Build the map.
`;

const newTempDir = useTempDirs("golem-plan-tasks-");

describe("parsePlanTask", () => {
  it("maps frontmatter onto a Task and the body onto the prompt", () => {
    const task = parsePlanTask(DOC);
    expect(task.id).toBe("R8.5");
    expect(task.title).toBe("Repo map");
    expect(task.state).toBe("queued");
    // The brief IS the prompt — that is what makes `task resume` work on a roadmap item.
    expect(task.prompt).toContain("## Goal");
    expect(task.prompt).toContain("Build the map.");
    expect(task.prompt).not.toContain("task: R8.5");
  });

  it("parses the roadmap metadata, including lists", () => {
    const plan = parsePlanTask(DOC).plan;
    expect(plan?.owner).toBe("agent");
    expect(plan?.size).toBe("L");
    expect(plan?.design).toBe("proposals/r8-context-economy.md");
    expect(plan?.gate).toBe("retrieval-accuracy harness");
    expect(plan?.dependsOn).toStrictEqual(["R8.4", "R8.3"]);
    expect(plan?.touches).toStrictEqual(["src/knowledge/", "src/mcp/"]);
    expect(plan?.blocked).toBeUndefined();
  });

  it("defaults owner and size rather than failing on a terse document", () => {
    const plan = parsePlanTask("---\ntask: X\n---\n\nbody\n").plan;
    expect(plan?.owner).toBe("agent");
    expect(plan?.size).toBe("M");
    expect(plan?.dependsOn).toStrictEqual([]);
  });

  it("reads a `blocked` reason", () => {
    const task = parsePlanTask("---\ntask: R7.5\nblocked: needs credentials\n---\n\nbody\n");
    expect(task.plan?.blocked).toBe("needs credentials");
  });

  it("reads a free-form `discipline`", () => {
    const task = parsePlanTask("---\ntask: R14.4\ndiscipline: code\n---\n\nbody\n");
    expect(task.plan?.discipline).toBe("code");
  });

  it("accepts a discipline nobody staffs — free-form, not a closed set", () => {
    const task = parsePlanTask("---\ntask: R14.4\ndiscipline: astrology\n---\n\nbody\n");
    expect(task.plan?.discipline).toBe("astrology");
  });

  it("leaves discipline undefined when absent, same as any other optional key", () => {
    const plan = parsePlanTask(DOC).plan;
    expect(plan?.discipline).toBeUndefined();
  });

  it("accepts a bare scalar where a list is expected (these files are hand-edited)", () => {
    const plan = parsePlanTask("---\ntask: X\ndepends_on: R8.5\n---\n\nbody\n").plan;
    expect(plan?.dependsOn).toStrictEqual(["R8.5"]);
  });

  it("tolerates a comment line and blank lines in the frontmatter", () => {
    const plan = parsePlanTask("---\n# a note\n\ntask: X\nsize: S\n---\n\nbody\n").plan;
    expect(plan?.size).toBe("S");
  });

  it("throws rather than inventing a task with no id", () => {
    expect(() => parsePlanTask("---\ntitle: no id\n---\n\nbody\n")).toThrow(/missing "task"/);
  });

  it("throws on missing delimiters and on an unknown state", () => {
    expect(() => parsePlanTask("no frontmatter here")).toThrow(/leading ---/);
    expect(() => parsePlanTask("---\ntask: X\n")).toThrow(/closing ---/);
    expect(() => parsePlanTask("---\ntask: X\nstate: nearly\n---\n\nb\n")).toThrow(/unknown state/);
  });

  it("parses CRLF the same as LF", () => {
    const task = parsePlanTask(DOC.replace(/\n/g, "\r\n"));
    expect(task.id).toBe("R8.5");
    expect(task.plan?.dependsOn).toStrictEqual(["R8.4", "R8.3"]);
  });
});

describe("serializePlanTask", () => {
  it("round-trips a document without drift", () => {
    const once = parsePlanTask(DOC);
    const twice = parsePlanTask(serializePlanTask(once));
    expect(twice).toStrictEqual(once);
  });

  it("round-trips a free-form discipline, including one nobody staffs", () => {
    const once = parsePlanTask("---\ntask: R14.4\ntitle: X\ndiscipline: astrology\n---\n\nbody\n");
    const twice = parsePlanTask(serializePlanTask(once));
    expect(twice).toStrictEqual(once);
    expect(twice.plan?.discipline).toBe("astrology");
    expect(serializePlanTask(once)).toContain("discipline: astrology");
  });

  it("re-serializing is stable, so a no-op write produces no diff", () => {
    const first = serializePlanTask(parsePlanTask(DOC));
    expect(serializePlanTask(parsePlanTask(first))).toBe(first);
  });

  it("omits absent optional keys instead of writing empty values", () => {
    const text = serializePlanTask(parsePlanTask("---\ntask: X\n---\n\nbody\n"));
    expect(text).not.toContain("discipline:");
    expect(text).not.toContain("design:");
    expect(text).not.toContain("gate:");
    expect(text).not.toContain("blocked:");
    // Lists always render, so a hand-editor can see the key exists.
    expect(text).toContain("depends_on: []");
  });
});

describe("planTaskSlug", () => {
  it("leaves a normal id alone", () => {
    expect(planTaskSlug("R8.5")).toBe("R8.5");
    expect(planTaskSlug("R7.6-infra")).toBe("R7.6-infra");
    expect(planTaskSlug("21e")).toBe("21e");
  });

  it("confines any id to the tasks directory", () => {
    // The property that matters is not a particular output string, it is that the
    // resolved path cannot leave the directory. Separators are replaced BEFORE
    // basename, so a traversal attempt becomes an ordinary (ugly) filename.
    const base = path.join("docs", "plan", "tasks");
    for (const hostile of [
      "../../../etc/passwd",
      "a b/c",
      "..",
      "./.././x",
      "C:\\Windows\\system32",
      "sub/dir/name",
    ]) {
      const resolved = path.resolve(base, `${planTaskSlug(hostile)}.md`);
      expect(resolved.startsWith(path.resolve(base) + path.sep)).toBe(true);
      expect(path.dirname(resolved)).toBe(path.resolve(base));
    }
  });
});

describe("PlanTaskStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await newTempDir();
  });

  it("returns an empty list when the directory does not exist", async () => {
    expect(await new PlanTaskStore(dir).list()).toStrictEqual([]);
  });

  it("round-trips through the filesystem", async () => {
    const store = new PlanTaskStore(dir);
    await store.put(parsePlanTask(DOC), "2026-07-31T00:00:00.000Z");
    const read = await store.get("R8.5");
    expect(read?.title).toBe("Repo map");
    expect(read?.updatedAt).toBe("2026-07-31T00:00:00.000Z");
    // A state change is not a new task: the original date survives.
    expect(read?.createdAt).toBe("2026-07-30");
  });

  it("writes to a filename derived from the id", async () => {
    await new PlanTaskStore(dir).put(parsePlanTask(DOC));
    expect(await readdir(planTasksDir(dir))).toStrictEqual(["R8.5.md"]);
  });

  it("skips an unparseable file instead of hiding the rest of the roadmap", async () => {
    const store = new PlanTaskStore(dir);
    await store.put(parsePlanTask(DOC));
    await writeFile(path.join(planTasksDir(dir), "broken.md"), "not a task", "utf8");
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe("R8.5");
  });

  it("ignores README.md and non-markdown files", async () => {
    const store = new PlanTaskStore(dir);
    await store.put(parsePlanTask(DOC));
    await writeFile(path.join(planTasksDir(dir), "README.md"), "# Plan tasks\n", "utf8");
    await writeFile(path.join(planTasksDir(dir), "notes.txt"), "scratch", "utf8");
    expect(await store.list()).toHaveLength(1);
  });

  it("returns null for a missing task rather than throwing", async () => {
    expect(await new PlanTaskStore(dir).get("nope")).toBeNull();
  });

  it("deletes, and delete of an absent task is a no-op", async () => {
    const store = new PlanTaskStore(dir);
    await store.put(parsePlanTask(DOC));
    await store.delete("R8.5");
    expect(await store.get("R8.5")).toBeNull();
    await expect(store.delete("R8.5")).resolves.toBeUndefined();
  });

  it("preserves createdAt across a state change", async () => {
    const store = new PlanTaskStore(dir);
    const original = await store.put(parsePlanTask(DOC), "2026-07-30T00:00:00.000Z");
    await store.put({ ...original, state: "done" }, "2026-08-05T00:00:00.000Z");
    const after = await store.get("R8.5");
    expect(after?.state).toBe("done");
    expect(after?.createdAt).toBe("2026-07-30");
    expect(after?.updatedAt).toBe("2026-08-05T00:00:00.000Z");
  });
});
