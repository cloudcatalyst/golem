/**
 * R5.1 — build the Claude Code relaunch command for a durable task.
 *
 * Mechanism verified in verification-notes §65: headless print mode (`-p`) plus
 * `--resume <session-id>` (deterministic) or `--continue` (most-recent). This
 * is a plain non-interactive process — no PTY, no terminal scripting — so the
 * argv is built here as a pure, cross-platform argument array (never a shell
 * string, per the CLAUDE.md hard rule against shell-string spawning).
 */

import type { Task } from "./types.js";

export interface ResumeArgvOptions {
  /** Executable to invoke (default "claude"; PATH-resolved by the spawner). */
  readonly claudeBin?: string;
  /** Add `--output-format json` for machine-readable resume output. */
  readonly outputJson?: boolean;
  /**
   * Permission mode to begin in (R5.4 autonomy hook pairs with this). One of
   * Claude Code's documented modes; omitted = the session/settings default.
   */
  readonly permissionMode?: string;
}

/**
 * The argument array to relaunch `task`. Prefers a deterministic
 * `--resume <sessionId>`; falls back to `--continue` when the task asked for
 * most-recent or has no session id yet.
 *
 * The prompt is always the LAST positional argument, passed as its own array
 * element so no quoting/escaping is ever needed.
 */
export function buildResumeArgv(task: Task, opts: ResumeArgvOptions = {}): string[] {
  const bin = opts.claudeBin ?? "claude";
  const argv: string[] = [bin];

  if (!task.continueLatest && task.sessionId !== undefined) {
    argv.push("--resume", task.sessionId);
  } else {
    // Most-recent conversation in the project dir (memo/§65 `-c`).
    argv.push("--continue");
  }

  if (opts.permissionMode !== undefined) {
    argv.push("--permission-mode", opts.permissionMode);
  }
  if (opts.outputJson === true) {
    argv.push("--output-format", "json");
  }

  // `-p` non-interactive, then the prompt as a single trailing positional.
  argv.push("-p", task.prompt);
  return argv;
}

/** Human-readable, copy-pasteable form of the argv (quotes args with spaces). */
export function formatResumeCommand(argv: string[]): string {
  return argv.map((a) => (/\s/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a)).join(" ");
}
