/**
 * R5.1 — file-backed TaskStore: round-trip, corrupt-file tolerance, delete.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTask, FileTaskStore, tasksDir } from "../../../src/tasks/index.js";

describe("FileTaskStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-tasks-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns [] when no tasks dir exists yet", async () => {
    expect(await new FileTaskStore(dir).list()).toEqual([]);
  });

  it("puts and gets a task, stamping updatedAt", async () => {
    const store = new FileTaskStore(dir);
    const task = createTask({ prompt: "p" }, "2026-07-16T00:00:00.000Z", "id-1");
    const stored = await store.put(task, "2026-07-16T01:00:00.000Z");
    expect(stored.updatedAt).toBe("2026-07-16T01:00:00.000Z");
    expect(stored.createdAt).toBe("2026-07-16T00:00:00.000Z");
    const got = await store.get("id-1");
    expect(got?.prompt).toBe("p");
    expect(got?.updatedAt).toBe("2026-07-16T01:00:00.000Z");
  });

  it("lists multiple tasks and skips corrupt / foreign files", async () => {
    const store = new FileTaskStore(dir);
    await store.put(createTask({ prompt: "a" }, undefined, "id-a"));
    await store.put(createTask({ prompt: "b" }, undefined, "id-b"));
    // Corrupt + non-JSON files in the dir must not break list().
    await mkdir(tasksDir(dir), { recursive: true });
    await writeFile(path.join(tasksDir(dir), "broken.json"), "{ not json", "utf8");
    await writeFile(path.join(tasksDir(dir), "notes.txt"), "ignore me", "utf8");
    const ids = (await store.list()).map((t) => t.id).sort();
    expect(ids).toEqual(["id-a", "id-b"]);
  });

  it("deletes a task (and is a no-op when absent)", async () => {
    const store = new FileTaskStore(dir);
    await store.put(createTask({ prompt: "p" }, undefined, "id-x"));
    await store.delete("id-x");
    expect(await store.get("id-x")).toBeNull();
    await expect(store.delete("id-x")).resolves.toBeUndefined();
  });

  it("get returns null for an unknown id", async () => {
    expect(await new FileTaskStore(dir).get("nope")).toBeNull();
  });
});
