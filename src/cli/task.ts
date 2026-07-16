/**
 * R5.1 — `golem task` CLI helpers: rendering + the (opt-in) resume spawn.
 *
 * Command wiring lives in main.ts; this module owns the presentation and the
 * one side-effecting bit (spawning the relaunch) so both stay testable.
 */

import { spawn } from "node:child_process";
import type { Task } from "../tasks/index.js";
import { formatResumeCommand } from "../tasks/index.js";

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

/** Detailed view for `golem task show <id>`. */
export function renderTask(task: Task): string {
  const lines: string[] = [];
  lines.push(`task ${task.id}`);
  lines.push(`  state:      ${task.state}`);
  lines.push(`  title:      ${taskTitle(task)}`);
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
  lines.push("  prompt:");
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
