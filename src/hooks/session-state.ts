/**
 * Decision 21b groundwork — Golem session state (the "blocked" flag).
 *
 * A tiny JSON file under `<project>/.golem/state/session.json` records whether
 * the Claude Code session is waiting on the human (a permission prompt or a
 * question). This is the shared state that a LOCAL indicator (status line / VS
 * Code panel) and the FUTURE remote controller both read — one source, many
 * renderers. Nothing here opens a network surface; that's 21b's later, guarded
 * step. All writes are best-effort and never throw into a hook.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Whether the session is blocked waiting for the human, and why. */
export interface SessionState {
  readonly blocked: boolean;
  /** Human-readable reason (the notification message), when blocked. */
  readonly reason?: string;
  readonly sessionId?: string;
  /** ISO-8601 timestamp of the last state change. */
  readonly ts: string;
}

/** State file location for a project. */
export function sessionStatePath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "session.json");
}

/** Read the session state, or null if none/unreadable. Never throws. */
export async function readSessionState(projectDir: string): Promise<SessionState | null> {
  try {
    const raw = await readFile(sessionStatePath(projectDir), "utf8");
    const j: unknown = JSON.parse(raw);
    if (typeof j !== "object" || j === null) return null;
    const o = j as Record<string, unknown>;
    if (typeof o.blocked !== "boolean" || typeof o.ts !== "string") return null;
    return {
      blocked: o.blocked,
      ts: o.ts,
      ...(typeof o.reason === "string" ? { reason: o.reason } : {}),
      ...(typeof o.sessionId === "string" ? { sessionId: o.sessionId } : {}),
    };
  } catch {
    return null;
  }
}

/** Write the session state atomically (temp + rename). Best-effort; never throws. */
export async function writeSessionState(projectDir: string, state: SessionState): Promise<void> {
  try {
    const file = sessionStatePath(projectDir);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tmp, file);
  } catch {
    // best-effort — a status indicator is not worth failing a hook over
  }
}

/** Mark the session blocked on the human. */
export function markBlocked(
  projectDir: string,
  reason: string,
  nowIso: string,
  sessionId?: string,
): Promise<void> {
  return writeSessionState(projectDir, {
    blocked: true,
    reason,
    ts: nowIso,
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}

/** Clear the blocked flag (the human responded / a tool ran). */
export function markUnblocked(projectDir: string, nowIso: string): Promise<void> {
  return writeSessionState(projectDir, { blocked: false, ts: nowIso });
}
