/**
 * R5.1 — durable task store (the `TaskStore` seam + a file-backed impl).
 *
 * One JSON file per task under `<project>/.golem/tasks/<id>.json`, zod-validated
 * on read (a corrupt/foreign file is skipped, never crashes a list). Writes go
 * through temp-file + rename for atomicity, mirroring `JsonFileSliderStore` and
 * the session/proxy state writers. Non-frozen seam (memo R5.1).
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Task, taskSchema } from "./types.js";

/** Persistence boundary for durable tasks. Implemented by {@link FileTaskStore}. */
export interface TaskStore {
  /** All tasks (order unspecified; callers sort). Invalid files are skipped. */
  list(): Promise<Task[]>;
  /** One task by id, or null if absent/unreadable. */
  get(id: string): Promise<Task | null>;
  /** Create or overwrite a task, stamping `updatedAt`. Returns the stored task. */
  put(task: Task, nowIso?: string): Promise<Task>;
  /** Remove a task file. No-op if absent. */
  delete(id: string): Promise<void>;
}

/** Directory holding one project's task files. */
export function tasksDir(projectDir: string): string {
  return path.join(projectDir, ".golem", "tasks");
}

/** File-backed {@link TaskStore} under `<project>/.golem/tasks/`. */
export class FileTaskStore implements TaskStore {
  readonly #dir: string;

  constructor(projectDir: string) {
    this.#dir = tasksDir(projectDir);
  }

  async list(): Promise<Task[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch {
      return []; // no tasks dir yet
    }
    const tasks: Task[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const task = await this.#readFile(path.join(this.#dir, name));
      if (task !== null) tasks.push(task);
    }
    return tasks;
  }

  get(id: string): Promise<Task | null> {
    return this.#readFile(this.#pathFor(id));
  }

  async put(task: Task, nowIso: string = new Date().toISOString()): Promise<Task> {
    const stored = taskSchema.parse({ ...task, updatedAt: nowIso });
    await mkdir(this.#dir, { recursive: true });
    const file = this.#pathFor(stored.id);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    await rename(tmp, file);
    return stored;
  }

  async delete(id: string): Promise<void> {
    await rm(this.#pathFor(id), { force: true });
  }

  #pathFor(id: string): string {
    // Guard against a malicious/typo'd id escaping the tasks dir.
    return path.join(this.#dir, `${path.basename(id)}.json`);
  }

  async #readFile(file: string): Promise<Task | null> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return null;
    }
    try {
      const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      const parsed = taskSchema.safeParse(JSON.parse(stripped));
      return parsed.success ? parsed.data : null;
    } catch {
      return null; // corrupt file — skip, never crash the list
    }
  }
}
