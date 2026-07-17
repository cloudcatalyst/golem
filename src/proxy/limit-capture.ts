/**
 * Auto-resume Phase 1 (proposals/auto-resume-on-limit.md) — the side-effecting
 * half of limit handling: given a {@link UsageLimitSignal} detected by the proxy,
 * (1) LOG the full signal to `.golem/state/limit-hits.jsonl` so the still-unknown
 * subscription session/weekly-limit shape is captured for validation, and
 * (2) CAPTURE a durable resume task gated to the reset time — but only for a real
 * exhaustion (reset beyond a threshold), never a transient per-minute 429.
 *
 * Phase 1 does NOT spawn anything — capture only records a task the user (or
 * Phase 2, once ADR-0002-gated) can resume. Fire-and-forget and fail-open: a
 * capture error can never affect the proxied response.
 *
 * Pure-ish: all I/O (task store, session id, clock, log sink) is injected, so
 * the decision logic is unit-testable without a filesystem or a real proxy.
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { TaskStore } from "../tasks/store.js";
import { createTask, TERMINAL_TASK_STATES } from "../tasks/types.js";
import type { UsageLimitSignal } from "./limit-detector.js";

/** Default minimum seconds-until-reset to capture (filters transient per-minute 429s). */
export const DEFAULT_MIN_CAPTURE_SECONDS = 120;

const CONTINUE_PROMPT =
  "Continue the work that was interrupted when the Claude session hit a usage " +
  "limit — resume where you left off.";

export interface LimitCaptureDeps {
  readonly store: TaskStore;
  /** Current Claude Code session id (from `.golem/state/`), or undefined. */
  readonly sessionId: () => Promise<string | undefined>;
  /** Append one structured log entry (limit-hits.jsonl, or a test spy). */
  readonly log: (entry: Record<string, unknown>) => Promise<void>;
  /** Injected clock (epoch ms) so tests are deterministic. */
  readonly now: () => number;
  /** Override the capture threshold (default {@link DEFAULT_MIN_CAPTURE_SECONDS}). */
  readonly minSecondsToCapture?: number;
}

/**
 * Stable, filename-safe task id derived from (session, reset-minute) so repeated
 * 429s within the same limit window update ONE task instead of piling up.
 */
export function captureTaskId(sessionId: string | undefined, resetAtIso: string): string {
  const bucket = resetAtIso.slice(0, 16); // yyyy-mm-ddThh:mm — dedupe within the minute
  const h = createHash("sha256")
    .update(`${sessionId ?? "nosession"}|${bucket}`)
    .digest("hex")
    .slice(0, 16);
  return `autoresume-${h}`;
}

/** `.golem/state/limit-hits.jsonl` for a project. */
export function limitHitsLogPath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "limit-hits.jsonl");
}

/** Best-effort append to the limit-hits log (never throws). */
export async function appendLimitHit(
  projectDir: string,
  entry: Record<string, unknown>,
): Promise<void> {
  try {
    const file = limitHitsLogPath(projectDir);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // observability only — never fail a capture over a log write
  }
}

/** Outcome of {@link captureLimit} — handy for tests and callers. */
export interface CaptureOutcome {
  /** The log entry was written. */
  readonly logged: boolean;
  /** A durable resume task was created/updated (false for transient/unknown-reset 429s). */
  readonly captured: boolean;
  /** The task id, when captured. */
  readonly taskId?: string;
}

/**
 * Handle one detected limit: log it always; capture a durable resume task only
 * when the reset is a real (non-transient) window with a known reset time.
 * Awaitable (unlike the fire-and-forget callback) so it is directly testable.
 */
export async function captureLimit(
  signal: UsageLimitSignal,
  deps: LimitCaptureDeps,
): Promise<CaptureOutcome> {
  const minSeconds = deps.minSecondsToCapture ?? DEFAULT_MIN_CAPTURE_SECONDS;
  const nowMs = deps.now();
  await deps.log({
    ts: new Date(nowMs).toISOString(),
    status: signal.statusCode,
    resetAt: signal.resetAtIso,
    secondsUntilReset: signal.secondsUntilReset,
    resetSource: signal.resetSource,
    retryAfter: signal.retryAfter,
    headers: signal.headers,
  });

  // Only a real exhaustion with a known reset is worth a durable task.
  if (signal.resetAtIso === null || signal.secondsUntilReset === null) {
    return { logged: true, captured: false };
  }
  if (signal.secondsUntilReset < minSeconds) return { logged: true, captured: false };

  const sessionId = await deps.sessionId();
  const id = captureTaskId(sessionId, signal.resetAtIso);
  const existing = await deps.store.get(id);
  // Respect the user: a task they already cancelled/finished for this window
  // must not be resurrected.
  if (existing !== null && TERMINAL_TASK_STATES.has(existing.state)) {
    return { logged: true, captured: false };
  }

  const nowIso = new Date(nowMs).toISOString();
  const base =
    existing ??
    createTask(
      {
        prompt: CONTINUE_PROMPT,
        title: "Auto-captured: resume after session-limit reset",
        ...(sessionId !== undefined ? { sessionId } : { continueLatest: true }),
        notBefore: signal.resetAtIso,
      },
      nowIso,
      id,
    );
  await deps.store.put({ ...base, notBefore: signal.resetAtIso }, nowIso);
  return { logged: true, captured: true, taskId: id };
}

/**
 * Build the observe-only `onUsageLimit` callback for the proxy. Fire-and-forget:
 * schedules the async handler and swallows any error so the proxied response is
 * never affected.
 */
export function buildLimitCapture(deps: LimitCaptureDeps): (signal: UsageLimitSignal) => void {
  return (signal) => {
    void captureLimit(signal, deps).catch(() => {});
  };
}
