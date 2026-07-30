/**
 * Plan tasks — roadmap-grade work as **committed task documents** (USER-requested
 * 2026-07-30).
 *
 * R5.1 gave Golem durable tasks, but only one *scope*: `<project>/.golem/tasks/`,
 * which is local, gitignored machine state. That is exactly right for what put it
 * there — a parked session, a snooze hold, a capacity-gated resume: facts about
 * *this* machine's in-flight work that nobody else should inherit.
 *
 * Roadmap items are the same *concept* and the opposite *lifetime*. "Build the repo
 * map" outlives a machine, wants review in a PR, and is the unit you hand to a fresh
 * agent or a separate conversation. So this module adds a second scope with the same
 * `Task` shape and the same `TaskStore` seam, differing only in where it lives and
 * how it is encoded:
 *
 * | scope | location | committed? | encoding | what it holds |
 * |---|---|---|---|---|
 * | local | `.golem/tasks/<uuid>.json` | no | JSON | parked sessions, snooze holds, resumes |
 * | plan  | `docs/plan/tasks/<id>.md` | **yes** | Markdown + frontmatter | roadmap work |
 *
 * **Why Markdown and not JSON.** A plan task is read by three audiences — a human
 * reviewing a diff, an agent being handed the work, and the CLI — and JSON serves
 * only the third. Frontmatter carries the machine fields; the body *is* the
 * dispatchable brief, and it maps onto `Task.prompt`, so the existing surfaces work
 * unchanged: `golem task show R8.5` prints the brief and `golem task resume R8.5`
 * builds a headless command from it. One task concept, two homes — not two systems.
 *
 * The frontmatter parser is hand-rolled in the same style as
 * `src/wiki/frontmatter.ts` and for the same reason: a small fixed key set does not
 * justify a YAML dependency (CLAUDE.md's dependency rule, Decision 53's tier ladder).
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { planMetaSchema, TASK_STATES, type Task, taskSchema } from "./types.js";

/** `docs/plan/tasks/` for a project. */
export function planTasksDir(projectDir: string): string {
  return path.join(projectDir, "docs", "plan", "tasks");
}

const DELIMITER = "---";

function parseList(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "[]") return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
  }
  // A bare scalar is a one-item list — forgiving, because these files are hand-edited.
  return [trimmed];
}

const LIST_KEYS = new Set(["depends_on", "touches"]);

/**
 * Parse a plan-task document into a {@link Task}.
 *
 * Throws on a malformed document rather than returning a partial one: unlike a
 * telemetry read (fail-open, the point is not to lose the request), a task file that
 * does not parse is work about to be silently dropped from the roadmap. The *store*
 * decides how loud that is — `list()` skips and keeps going, `get()` surfaces it.
 */
export function parsePlanTask(raw: string): Task {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== DELIMITER) {
    throw new Error("plan task is missing the leading --- frontmatter delimiter");
  }
  const closing = lines.findIndex((line, i) => i >= 1 && line.trim() === DELIMITER);
  if (closing === -1) {
    throw new Error("plan task is missing the closing --- frontmatter delimiter");
  }

  const values: Record<string, string | string[]> = {};
  for (const line of lines.slice(1, closing)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const colonAt = line.indexOf(":");
    if (colonAt === -1) throw new Error(`malformed frontmatter line (no ':'): ${line}`);
    const key = line.slice(0, colonAt).trim();
    const value = line.slice(colonAt + 1).trim();
    values[key] = LIST_KEYS.has(key) ? parseList(value) : value;
  }

  const id = values.task;
  if (typeof id !== "string" || id === "") {
    throw new Error('plan task frontmatter is missing "task" (the stable id, e.g. R8.5)');
  }
  const state = typeof values.state === "string" ? values.state : "queued";
  if (!(TASK_STATES as readonly string[]).includes(state)) {
    throw new Error(`plan task "${id}" has an unknown state "${state}"`);
  }

  let bodyStart = closing + 1;
  if (bodyStart < lines.length && lines[bodyStart]?.trim() === "") bodyStart += 1;
  const body = lines.slice(bodyStart).join("\n").trimEnd();

  const created = typeof values.created === "string" ? values.created : "";
  const plan = planMetaSchema.parse({
    ...(typeof values.owner === "string" ? { owner: values.owner } : {}),
    ...(typeof values.size === "string" ? { size: values.size } : {}),
    ...(typeof values.design === "string" && values.design !== "" ? { design: values.design } : {}),
    ...(typeof values.gate === "string" && values.gate !== "" ? { gate: values.gate } : {}),
    ...(typeof values.blocked === "string" && values.blocked !== ""
      ? { blocked: values.blocked }
      : {}),
    dependsOn: Array.isArray(values.depends_on) ? values.depends_on : [],
    touches: Array.isArray(values.touches) ? values.touches : [],
  });

  return taskSchema.parse({
    id,
    createdAt: created,
    updatedAt: typeof values.updated === "string" ? values.updated : created,
    state,
    // The brief IS the prompt — that is what makes `task resume` work on a roadmap item.
    prompt: body,
    ...(typeof values.title === "string" && values.title !== "" ? { title: values.title } : {}),
    checkpoints: [],
    attempts: 0,
    plan,
  });
}

/** Serialize a {@link Task} back to a plan-task document. */
export function serializePlanTask(task: Task): string {
  const plan = task.plan ?? planMetaSchema.parse({});
  const head = [
    DELIMITER,
    `task: ${task.id}`,
    `title: ${task.title ?? task.id}`,
    `state: ${task.state}`,
    `owner: ${plan.owner}`,
    `size: ${plan.size}`,
    ...(plan.design !== undefined ? [`design: ${plan.design}`] : []),
    ...(plan.gate !== undefined ? [`gate: ${plan.gate}`] : []),
    ...(plan.blocked !== undefined ? [`blocked: ${plan.blocked}`] : []),
    `depends_on: [${plan.dependsOn.join(", ")}]`,
    `touches: [${plan.touches.join(", ")}]`,
    `created: ${task.createdAt}`,
    `updated: ${task.updatedAt}`,
    DELIMITER,
  ];
  return `${head.join("\n")}\n\n${task.prompt.trimEnd()}\n`;
}

/**
 * A task id safe to use as a filename.
 *
 * Ids are human-chosen (`R8.5`, `21e`) rather than UUIDs, so this both slugifies and
 * confines: `path.basename` after replacement, so no id can escape the tasks dir.
 */
export function planTaskSlug(id: string): string {
  return path.basename(id.replace(/[^\w.-]+/g, "-"));
}

/**
 * File-backed store over `docs/plan/tasks/*.md`.
 *
 * Implements the same {@link TaskStore} shape as `FileTaskStore` so every existing
 * `golem task` surface works on a roadmap item without special-casing. It does NOT
 * extend it: the encodings differ, and inheritance would invite a write through the
 * JSON path into a Markdown file.
 */
export class PlanTaskStore {
  readonly #dir: string;

  constructor(projectDir: string) {
    this.#dir = planTasksDir(projectDir);
  }

  /** Every readable plan task. An unparseable file is skipped, never fatal to a list. */
  async list(): Promise<Task[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch {
      return [];
    }
    const tasks: Task[] = [];
    for (const name of names) {
      if (!name.endsWith(".md") || name === "README.md") continue;
      try {
        const raw = await readFile(path.join(this.#dir, name), "utf8");
        tasks.push(parsePlanTask(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw));
      } catch {
        // Skip: one bad file must not hide the rest of the roadmap.
      }
    }
    return tasks;
  }

  /** One task by id, or null. */
  async get(id: string): Promise<Task | null> {
    try {
      const raw = await readFile(this.#pathFor(id), "utf8");
      return parsePlanTask(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    } catch {
      return null;
    }
  }

  /**
   * Create or update a task document, stamping `updatedAt`.
   *
   * Preserves the existing `createdAt` when one is on disk — a state change is not a
   * new task, and losing the original date would make the roadmap's age unreadable.
   */
  async put(task: Task, nowIso: string = new Date().toISOString()): Promise<Task> {
    const existing = await this.get(task.id);
    const stored = taskSchema.parse({
      ...task,
      createdAt: task.createdAt !== "" ? task.createdAt : (existing?.createdAt ?? nowIso),
      updatedAt: nowIso,
    });
    await mkdir(this.#dir, { recursive: true });
    const file = this.#pathFor(stored.id);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, serializePlanTask(stored), "utf8");
    await rename(tmp, file);
    return stored;
  }

  async delete(id: string): Promise<void> {
    await rm(this.#pathFor(id), { force: true });
  }

  #pathFor(id: string): string {
    return path.join(this.#dir, `${planTaskSlug(id)}.md`);
  }
}
