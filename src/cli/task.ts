/**
 * R5.1 — `golem task` CLI helpers: rendering + the (opt-in) resume spawn.
 *
 * Command wiring lives in main.ts; this module owns the presentation and the
 * one side-effecting bit (spawning the relaunch) so both stay testable.
 */

import { spawn } from "node:child_process";
import type { Task, TaskStore } from "../tasks/index.js";
import { FileTaskStore, formatResumeCommand, PlanTaskStore } from "../tasks/index.js";

/**
 * Which home a task lives in.
 *
 * `local` — `.golem/tasks/*.json`, uncommitted machine state (parked sessions,
 * snooze holds, capacity-gated resumes). `plan` — `docs/plan/tasks/*.md`, committed
 * roadmap work. One concept, two lifetimes; see `src/tasks/plan-task.ts`.
 */
export type TaskScope = "local" | "plan";

export interface ScopedTask {
  readonly task: Task;
  readonly scope: TaskScope;
}

/** The store a scope reads and writes. */
export function storeForScope(scope: TaskScope, projectDir: string): TaskStore {
  return scope === "plan" ? new PlanTaskStore(projectDir) : new FileTaskStore(projectDir);
}

/**
 * List both scopes.
 *
 * Plan tasks come first so `golem task list` opens on the roadmap rather than on
 * whatever this machine happens to have parked — the committed set is the shared
 * picture, the local set is this session's.
 */
export async function listScopedTasks(projectDir: string, only?: TaskScope): Promise<ScopedTask[]> {
  const out: ScopedTask[] = [];
  if (only !== "local") {
    for (const task of await new PlanTaskStore(projectDir).list()) {
      out.push({ task, scope: "plan" });
    }
  }
  if (only !== "plan") {
    for (const task of await new FileTaskStore(projectDir).list()) {
      out.push({ task, scope: "local" });
    }
  }
  return out;
}

/**
 * Resolve a task by full id or a unique id prefix (the short id `task list`
 * prints). Returns the task, `"none"`, or `"ambiguous"`.
 */
export function findTask(tasks: readonly Task[], idOrPrefix: string): Task | "none" | "ambiguous" {
  const exact = tasks.find((t) => t.id === idOrPrefix);
  if (exact !== undefined) return exact;
  const matches = tasks.filter((t) => t.id.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0] as Task;
  return matches.length === 0 ? "none" : "ambiguous";
}

/**
 * Resolve across both scopes, keeping the scope so a mutation writes back to the
 * store the task actually came from.
 *
 * Exact-id match wins outright — plan ids are short and human (`R8.5`, `21e`), so a
 * prefix search alone would make `R8` ambiguous against `R8.5`/`R8.6` and refuse a
 * perfectly unambiguous id. Case-insensitive on the exact pass, because nobody types
 * `r8.5` meaning something else.
 */
export function findScopedTask(
  entries: readonly ScopedTask[],
  idOrPrefix: string,
): ScopedTask | "none" | "ambiguous" {
  const wanted = idOrPrefix.toLowerCase();
  const exact = entries.filter((e) => e.task.id.toLowerCase() === wanted);
  if (exact.length === 1) return exact[0] as ScopedTask;
  if (exact.length > 1) return "ambiguous";
  const matches = entries.filter((e) => e.task.id.toLowerCase().startsWith(wanted));
  if (matches.length === 1) return matches[0] as ScopedTask;
  return matches.length === 0 ? "none" : "ambiguous";
}

/** One-line title for a task (explicit title, else a prompt prefix). */
export function taskTitle(task: Task): string {
  if (task.title !== undefined && task.title.length > 0) return task.title;
  const firstLine = task.prompt.split("\n", 1)[0] ?? "";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

/** Compact table for `golem task list`, newest-updated first. */
export function renderTaskList(tasks: readonly Task[]): string {
  if (tasks.length === 0) return "no tasks (add one with `golem task add`)\n";
  const sorted = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const lines = sorted.map((t) => {
    const gate = t.notBefore !== undefined ? ` (not before ${t.notBefore})` : "";
    const id = t.id.slice(0, 8);
    return `  ${id}  ${t.state.padEnd(9)} ${taskTitle(t)}${gate}`;
  });
  return `${lines.join("\n")}\n`;
}

/**
 * Both scopes in one table, plan tasks first.
 *
 * The scope column is not decoration: it says whether closing the task means editing
 * a committed document (reviewable, shared) or dropping a local JSON file (this
 * machine only). Plan ids print in full — they are short and meaningful, and
 * truncating `R8.5` to 8 chars would be worse than useless.
 */
export function renderScopedTaskList(entries: readonly ScopedTask[]): string {
  if (entries.length === 0) {
    return "no tasks (roadmap work: `golem task index`; a local park: `golem task add`)\n";
  }
  const plan = entries.filter((e) => e.scope === "plan");
  const local = entries
    .filter((e) => e.scope === "local")
    .sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt));
  const lines: string[] = [];

  if (plan.length > 0) {
    lines.push(`plan (committed, docs/plan/tasks/) — ${plan.length}:`);
    for (const { task } of [...plan].sort((a, b) => a.task.id.localeCompare(b.task.id, "en"))) {
      const meta = task.plan;
      const blocked = meta?.blocked !== undefined ? `  [blocked: ${meta.blocked}]` : "";
      lines.push(
        `  ${task.id.padEnd(10)} ${task.state.padEnd(9)} ${(meta?.owner ?? "agent").padEnd(5)} ` +
          `${(meta?.size ?? "M").padEnd(2)} ${taskTitle(task)}${blocked}`,
      );
    }
  }

  if (local.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`local (this machine, .golem/tasks/) — ${local.length}:`);
    for (const { task } of local) {
      const gate = task.notBefore !== undefined ? ` (not before ${task.notBefore})` : "";
      lines.push(`  ${task.id.slice(0, 8)}  ${task.state.padEnd(9)} ${taskTitle(task)}${gate}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Detailed view for `golem task show <id>`. */
export function renderTask(task: Task): string {
  const lines: string[] = [];
  lines.push(`task ${task.id}`);
  lines.push(`  state:      ${task.state}`);
  lines.push(`  title:      ${taskTitle(task)}`);
  if (task.plan !== undefined) {
    const plan = task.plan;
    lines.push(`  scope:      plan (committed document)`);
    lines.push(`  owner:      ${plan.owner}`);
    lines.push(`  size:       ${plan.size}`);
    if (plan.design !== undefined) lines.push(`  design:     ${plan.design}`);
    if (plan.gate !== undefined) lines.push(`  gate:       ${plan.gate}`);
    if (plan.blocked !== undefined) lines.push(`  BLOCKED:    ${plan.blocked}`);
    if (plan.dependsOn.length > 0) lines.push(`  depends on: ${plan.dependsOn.join(", ")}`);
    if (plan.touches.length > 0) lines.push(`  touches:    ${plan.touches.join(", ")}`);
  }
  lines.push(`  created:    ${task.createdAt}`);
  lines.push(`  updated:    ${task.updatedAt}`);
  lines.push(`  attempts:   ${task.attempts}`);
  if (task.sessionId !== undefined) lines.push(`  session:    ${task.sessionId}`);
  if (task.continueLatest) lines.push("  resume:     --continue (most recent)");
  if (task.agentType !== undefined) lines.push(`  agent:      ${task.agentType}`);
  if (task.idempotencyKey !== undefined) lines.push(`  idem-key:   ${task.idempotencyKey}`);
  if (task.notBefore !== undefined) lines.push(`  not before: ${task.notBefore}`);
  if (task.worktree !== undefined) {
    lines.push(`  worktree:   ${task.worktree.path} @ ${task.worktree.baseCommit}`);
    if (task.worktree.dirtyFiles.length > 0) {
      lines.push(`    dirty:    ${task.worktree.dirtyFiles.join(", ")}`);
    }
  }
  if (task.lastError !== undefined) lines.push(`  last error: ${task.lastError}`);
  if (task.checkpoints.length > 0) {
    lines.push("  checkpoints:");
    for (const c of task.checkpoints) {
      lines.push(`    [${c.status}] ${c.label}${c.note !== undefined ? ` — ${c.note}` : ""}`);
    }
  }
  lines.push(task.plan !== undefined ? "  brief:" : "  prompt:");
  for (const line of task.prompt.split("\n")) lines.push(`    ${line}`);
  return `${lines.join("\n")}\n`;
}

export interface SpawnResult {
  readonly spawned: boolean;
  readonly pid?: number;
  /** Set when the spawn was not attempted or failed — the command to run by hand. */
  readonly command: string;
  readonly note?: string;
}

/**
 * Spawn the relaunch as a detached, argument-array process (no shell — the
 * CLAUDE.md hard rule). Cross-platform via `spawn(bin, args)`. If the binary
 * can't be launched (common on Windows when `claude` is a `.cmd` not on the
 * exec path), we DON'T fall back to a shell string (injection risk) — we return
 * the copy-pasteable command so the user runs it themselves. Honest degradation
 * over a fragile auto-launch.
 */
export function spawnResume(argv: string[]): SpawnResult {
  const command = formatResumeCommand(argv);
  const bin = argv[0];
  const rest = argv.slice(1);
  if (bin === undefined) return { spawned: false, command, note: "empty command" };
  try {
    const child = spawn(bin, rest, { detached: true, stdio: "ignore" });
    let failed: string | undefined;
    child.on("error", (err) => {
      failed = err.message;
    });
    // If it errored synchronously (ENOENT), `failed` is set before we unref.
    if (failed !== undefined) {
      return { spawned: false, command, note: `spawn failed: ${failed} — run it manually` };
    }
    child.unref();
    return child.pid !== undefined
      ? { spawned: true, pid: child.pid, command }
      : { spawned: false, command, note: "spawn produced no pid — run it manually" };
  } catch (err) {
    const note = `spawn failed: ${err instanceof Error ? err.message : String(err)} — run it manually`;
    return { spawned: false, command, note };
  }
}
