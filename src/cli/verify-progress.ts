/**
 * long-run-visibility — the progress record `golem verify` writes and
 * `golem statusline` reads.
 *
 * Deliberately a separate module from `verify.ts`, which spawns processes. The
 * status line re-runs every {@link STATUS_LINE_REFRESH_INTERVAL_SEC} seconds on
 * a hot path (verification-notes §86), so it must be able to import the READER
 * without pulling in the runner, its `node:child_process` use, or the check
 * table. Nothing here imports anything but `node:fs/promises` and `node:path`.
 *
 * ## Staleness is the load-bearing part
 *
 * A run writes a heartbeat while it works. A killed session, a crashed process
 * or a machine that slept all leave the file behind, and a status line that
 * trusted it would pin a phantom "verify running" on screen forever — worse
 * than showing nothing, because it is confidently wrong. So a record whose
 * heartbeat is older than {@link STALE_AFTER_MS} is read as NO run at all: the
 * honest reading of "whatever owned this is gone".
 *
 * The heartbeat interval must stay well under that window, or a long check
 * (`vitest` takes ~6 minutes here) would look dead while it is working.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

/** One finished check. `exit` is kept because "failed" and "failed how" differ. */
export interface VerifyCheckResult {
  readonly id: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly exit: number;
}

/** The whole run, as last written. */
export interface VerifyProgress {
  readonly runId: string;
  readonly total: number;
  readonly done: readonly VerifyCheckResult[];
  /** The check currently running, or null between checks / at the end. */
  readonly current: string | null;
  readonly startedAt: number;
  /** Heartbeat. Compared against {@link STALE_AFTER_MS} to detect a dead owner. */
  readonly updatedAt: number;
  readonly finishedAt?: number;
  readonly ok?: boolean;
  readonly logPath: string;
}

/**
 * How old a heartbeat may be before the record is treated as abandoned. Six
 * times the write interval, so a slow filesystem or a busy machine does not
 * flicker the segment off mid-run.
 */
export const STALE_AFTER_MS = 30_000;

/** How often the runner refreshes `updatedAt` while a single check runs. */
export const HEARTBEAT_MS = 5_000;

/** Under `.golem/state/`, which is gitignored — this is machine-local run state. */
export function verifyProgressPath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "verify.json");
}

/** `12.4s`, `2m10s` — short enough for a status line, exact enough to be useful. */
export function formatElapsed(ms: number): string {
  const secs = Math.max(0, ms) / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const m = Math.floor(secs / 60);
  return `${m}m${String(Math.floor(secs - m * 60)).padStart(2, "0")}s`;
}

/**
 * The status-line segment for a run IN FLIGHT, or null when there is nothing
 * honest to show — no record, a finished run, or a stale heartbeat.
 *
 * Pure, so the rendering is testable without touching a filesystem or a clock.
 */
export function renderVerifySegment(progress: VerifyProgress | null, nowMs: number): string | null {
  if (!progress) return null;
  if (progress.finishedAt !== undefined) return null;
  if (nowMs - progress.updatedAt > STALE_AFTER_MS) return null;

  const done = progress.done.length;
  const failed = progress.done.some((d) => !d.ok);
  // A failure already recorded is shown while the rest of the run continues:
  // finding out at the end that check 2 failed is the thing this replaces.
  const mark = failed ? "✖" : "⏳";
  const label = progress.current ?? "…";
  return `${mark} verify ${done}/${progress.total} · ${label} ${formatElapsed(nowMs - progress.startedAt)}`;
}

/**
 * Read the record, or null. Never throws: a missing file is the common case
 * (no run has happened), and a malformed one must not take the status line
 * down with it.
 */
export async function readVerifyProgress(projectDir: string): Promise<VerifyProgress | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(verifyProgressPath(projectDir), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as Partial<VerifyProgress>;
    if (typeof p.total !== "number" || typeof p.updatedAt !== "number") return null;
    if (!Array.isArray(p.done)) return null;
    return p as VerifyProgress;
  } catch {
    return null;
  }
}
