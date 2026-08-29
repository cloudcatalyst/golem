/**
 * R13.3 — hosted-session lifecycle: what exists, and what is still alive.
 *
 * A hosted session outlives the CLI invocation that created it, so something
 * has to remember it. This is that something: a small JSON file per project
 * listing every session started here, with the pid running it.
 *
 * ## Sessions are per project root
 *
 * Two roots are two sessions (brief item 5). A worktree resolves the same way
 * `ccr-ref-scope` decided — by its own root, not the main checkout's — because a
 * worktree is a different working tree and a session in it is a different
 * session. The registry lives under the root it belongs to, so that resolution
 * is structural rather than a lookup rule that could disagree with itself.
 *
 * ## Liveness is checked, never assumed
 *
 * A pid in this file is a claim, not a fact — a crash, a reboot or a `kill -9`
 * leaves it behind. Every read tests the pid and reports `dead` rather than
 * pretending, which is the same discipline `proxy-daemon.ts` applies to its own
 * pid file.
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "../config/file-io.js";

export function hostRegistryPath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "hosted-sessions.json");
}

/** Where a detached session's transcript is tee'd, so `attach` has scrollback. */
export function hostSessionLogPath(projectDir: string, sessionId: string): string {
  return path.join(projectDir, ".golem", "state", "sessions", `${sessionId}.jsonl`);
}

export interface HostSessionRecord {
  /** Golem's id for the session — stable, and what the audit log is keyed by. */
  readonly id: string;
  /** The runner's own session id, once the first `system/init` reveals it. */
  readonly runnerSessionId?: string;
  readonly projectDir: string;
  readonly startedAt: string;
  /** The process running it. Checked, never trusted. */
  readonly pid: number;
  /** Set when the session ended in a way Golem observed. */
  readonly stoppedAt?: string;
  readonly lastError?: string;
}

interface RegistryFile {
  readonly version: 1;
  readonly sessions: readonly HostSessionRecord[];
}

const EMPTY: RegistryFile = { version: 1, sessions: [] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function read(projectDir: string): Promise<RegistryFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(hostRegistryPath(projectDir), "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.sessions)) return EMPTY;
    return {
      version: 1,
      sessions: parsed.sessions.filter(
        (s): s is HostSessionRecord =>
          isRecord(s) && typeof s.id === "string" && typeof s.pid === "number",
      ),
    };
  } catch {
    return EMPTY;
  }
}

async function write(projectDir: string, file: RegistryFile): Promise<void> {
  const p = hostRegistryPath(projectDir);
  await mkdir(path.dirname(p), { recursive: true });
  await writeAtomic(p, `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * Is this pid still running?
 *
 * `kill(pid, 0)` throws `ESRCH` for a dead process and `EPERM` for one this user
 * cannot signal — and EPERM means it EXISTS, so it counts as alive. Same
 * reasoning as `proxy-daemon.ts`'s check.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface LiveHostSession extends HostSessionRecord {
  readonly alive: boolean;
}

/** Every recorded session, with liveness tested at read time. */
export async function listHostSessions(projectDir: string): Promise<readonly LiveHostSession[]> {
  const file = await read(projectDir);
  return file.sessions.map((s) => ({
    ...s,
    alive: s.stoppedAt === undefined && isAlive(s.pid),
  }));
}

/** One session by id, or `null`. */
export async function findHostSession(
  projectDir: string,
  id: string,
): Promise<LiveHostSession | null> {
  return (await listHostSessions(projectDir)).find((s) => s.id === id) ?? null;
}

export async function registerHostSession(
  projectDir: string,
  record: HostSessionRecord,
): Promise<void> {
  const file = await read(projectDir);
  await write(projectDir, {
    version: 1,
    sessions: [...file.sessions.filter((s) => s.id !== record.id), record],
  });
}

/** Patch a recorded session — used to fill in the runner's id and to mark it stopped. */
export async function updateHostSession(
  projectDir: string,
  id: string,
  patch: Partial<HostSessionRecord>,
): Promise<void> {
  const file = await read(projectDir);
  await write(projectDir, {
    version: 1,
    sessions: file.sessions.map((s) => (s.id === id ? { ...s, ...patch } : s)),
  });
}

/** Forget a session record entirely. The transcript file is removed with it. */
export async function forgetHostSession(projectDir: string, id: string): Promise<boolean> {
  const file = await read(projectDir);
  const next = file.sessions.filter((s) => s.id !== id);
  if (next.length === file.sessions.length) return false;
  await write(projectDir, { version: 1, sessions: next });
  await rm(hostSessionLogPath(projectDir, id), { force: true });
  return true;
}

/**
 * Drop records for sessions that are neither alive nor cleanly stopped — the
 * leftovers of a crash or a reboot. Called before listing so the user is never
 * shown a running session that is not.
 */
export async function reapDeadSessions(projectDir: string, nowIso: string): Promise<number> {
  const file = await read(projectDir);
  let reaped = 0;
  const sessions = file.sessions.map((s) => {
    if (s.stoppedAt !== undefined || isAlive(s.pid)) return s;
    reaped += 1;
    return {
      ...s,
      stoppedAt: nowIso,
      lastError: s.lastError ?? "process is gone — reaped (crash, kill, or reboot)",
    };
  });
  if (reaped > 0) await write(projectDir, { version: 1, sessions });
  return reaped;
}
