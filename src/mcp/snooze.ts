/**
 * Golem snooze — core wait logic for the `snooze` MCP tool (proposal
 * docs/plan/proposals/golem-snooze.md).
 *
 * A tool call is a near-free wait: while an MCP tool blocks, the model generates
 * nothing, so no quota is consumed. Claude Code has no hard max tool-call
 * duration — a long call is bounded only by an *idle* timeout that a tool
 * survives indefinitely by emitting progress notifications (verification: the
 * proposal). So `snooze` blocks the LIVE session until a usage-limit reset,
 * emitting a periodic heartbeat, then returns — and the same conversation
 * continues in-place.
 *
 * This module is the timing core, factored out of the MCP handler so it is
 * unit-testable with an injected clock/sleep/heartbeat (the real handler in
 * server.ts wires `Date.now`, an abortable timer, and `extra.sendNotification`).
 */

/**
 * Hard cap on how long one snooze may block. Sized for the ~5h session window
 * plus margin; a reset further out than this (e.g. a multi-day weekly limit) is
 * DECLINED rather than waited on — holding the machine awake for days is not the
 * job, and returning `reset:true` after capping would be a lie.
 */
export const DEFAULT_SNOOZE_MAX_MS = 6 * 60 * 60 * 1000;

/** Heartbeat cadence: emit a progress notification this often to reset the idle timer. */
export const SNOOZE_HEARTBEAT_MS = 60_000;

/** Bad caller input (neither target given, unparseable `until`). Surfaced as an MCP error result. */
export class SnoozeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnoozeInputError";
  }
}

export interface SnoozeInput {
  /** ISO-8601 reset time to wait until (e.g. from a rate-limit reset header). */
  readonly until?: string;
  /** Explicit wait duration in ms (alternative to `until`). */
  readonly durationMs?: number;
  /** Hard cap on the wait; default {@link DEFAULT_SNOOZE_MAX_MS}. */
  readonly maxMs?: number;
}

export interface SnoozeOutcome {
  /** True when the full wait elapsed (the window should have reset). */
  readonly reset: boolean;
  /** How long it actually waited (ms). */
  readonly waitedMs: number;
  /** The resolved wait target (ms from start), before any cap decline. */
  readonly targetMs: number;
  /** Progress notifications successfully emitted. */
  readonly heartbeats: number;
  /** When `reset` is false: why (cancelled / beyond the cap). */
  readonly reason?: string;
}

export interface SnoozeDeps {
  readonly now: () => number;
  /** Sleep `ms`, resolving early (not rejecting) if `signal` aborts. */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Emit one heartbeat (progress notification). May throw — the loop keeps waiting. */
  readonly heartbeat: () => Promise<void> | void;
  readonly signal?: AbortSignal;
  /** Override {@link SNOOZE_HEARTBEAT_MS} (tests). */
  readonly heartbeatMs?: number;
}

/**
 * Resolve the raw wait target in ms-from-now (>= 0). A past `until` yields 0
 * ("already reset, nothing to wait"). Pure. Throws {@link SnoozeInputError} when
 * neither target is given or `until` is unparseable.
 */
export function resolveSnoozeTargetMs(input: SnoozeInput, nowMs: number): number {
  if (input.until !== undefined) {
    const t = Date.parse(input.until);
    if (!Number.isFinite(t)) {
      throw new SnoozeInputError(`invalid \`until\` timestamp: ${JSON.stringify(input.until)}`);
    }
    return Math.max(0, t - nowMs);
  }
  if (input.durationMs !== undefined) {
    return Math.max(0, input.durationMs);
  }
  throw new SnoozeInputError("provide `until` (an ISO reset time) or `duration_ms`");
}

/**
 * Block until the resolved target elapses, emitting a heartbeat every
 * `heartbeatMs`. Declines (without waiting) when the target is beyond `maxMs`.
 * Honors `signal`: an abort ends the wait early with `reset:false`. A heartbeat
 * that throws is swallowed (the idle-timeout config is the fallback) and the
 * wait continues.
 */
export async function runSnooze(input: SnoozeInput, deps: SnoozeDeps): Promise<SnoozeOutcome> {
  const target = resolveSnoozeTargetMs(input, deps.now());
  const max = input.maxMs ?? DEFAULT_SNOOZE_MAX_MS;
  if (target > max) {
    const hrs = (ms: number): string => (ms / 3_600_000).toFixed(1);
    return {
      reset: false,
      waitedMs: 0,
      targetMs: target,
      heartbeats: 0,
      reason: `reset is ${hrs(target)}h away, beyond the ${hrs(max)}h snooze cap (a weekly limit?) — not waiting`,
    };
  }

  const hb = deps.heartbeatMs ?? SNOOZE_HEARTBEAT_MS;
  let waited = 0;
  let heartbeats = 0;
  if (deps.signal?.aborted) {
    return { reset: false, waitedMs: 0, targetMs: target, heartbeats, reason: "cancelled" };
  }
  while (waited < target) {
    const chunk = Math.min(hb, target - waited);
    await deps.sleep(chunk, deps.signal);
    if (deps.signal?.aborted) {
      return { reset: false, waitedMs: waited, targetMs: target, heartbeats, reason: "cancelled" };
    }
    waited += chunk;
    if (waited < target) {
      try {
        await deps.heartbeat();
        heartbeats += 1;
      } catch {
        // Heartbeat failed (no progress token / transport hiccup). Keep waiting —
        // the raised/disabled idle timeout (init config) is the fallback.
      }
    }
  }
  return { reset: true, waitedMs: waited, targetMs: target, heartbeats };
}

/** A real timer sleep that resolves after `ms` OR when `signal` aborts (never rejects). */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
