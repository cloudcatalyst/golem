/**
 * Snooze document-and-hold trigger (snooze proposal docs/plan/proposals/golem-snooze.md,
 * P2b). Decides — from the proxy's persisted limit prediction (P2a) — whether the
 * PreToolUse gate should tell the agent to park as the usage window fills, and
 * enforces a ONE-SHOT per reset window so the nudge is a single non-polluting
 * redirect, not a per-tool-call repeat.
 *
 * The nudge itself instructs the document-and-hold pattern: capture progress into
 * a durable task, call the `snooze` MCP tool (which may auto-background), and wait
 * — the session resumes in-place when snooze completes at the reset. No global
 * config override (that was reverted); this leans on backgrounding, not a
 * foreground block.
 *
 * ## Staleness (Decision 44-followup)
 * The park decision is only as good as the persisted prediction, and that
 * prediction only refreshes when an upstream response carries the
 * `anthropic-ratelimit-unified-*` headers. If the active account/upstream stops
 * emitting them — e.g. an account switch to an API-key upstream mid-session — the
 * feed goes cold and `limit-state.json` freezes at its last reading. The old
 * logic then failed SILENTLY (a stale low reading, or an expired window, just
 * returned "no nudge"), so the parking net vanished exactly when it mattered.
 * `decideSnoozeNudge` now distinguishes three outcomes: `park` (fresh + near
 * limit), `stale` (the feed has gone cold — warn once so the blindness is
 * visible), and `none`. Park only ever fires on a FRESH reading.
 *
 * Decision logic drafted with the local `coder` model, then hardened here
 * (atomic cross-platform I/O, fail-open) to match `limit-prediction.ts`.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LimitPrediction } from "../proxy/limit-prediction.js";

/** Session-window utilization at/above which the gate nudges the agent to park. */
export const DEFAULT_NUDGE_UTILIZATION = 0.9;

/**
 * How old the last observed prediction may be before the header feed is treated
 * as cold. During active work the proxy refreshes `limit-state.json` on every
 * upstream turn (throttled to ~3 s), so a reading older than this while the
 * session is issuing tool calls means the feed has stopped — not that the user
 * paused. Conservative enough to avoid false alarms in normal operation.
 */
export const STALE_AFTER_MS = 30 * 60 * 1000; // 30 minutes

/** One-shot state persisted under `.golem/state/snooze-nudge.json`. */
export interface SnoozeNudgeState {
  /** The 5h reset window (ISO) we last emitted a PARK nudge for. */
  readonly nudgedForResetIso?: string;
  /** The `observedAtIso` of the stale reading we last emitted a STALE warning for. */
  readonly staleWarnedForObservedIso?: string;
}

/**
 * Outcome of a nudge decision.
 * - `park`  — fresh reading, at/above threshold, future reset, not yet nudged.
 * - `stale` — the prediction feed has gone cold (warn once so it's visible).
 * - `none`  — nothing to say (fresh + below threshold, already-nudged, or no data).
 */
export type SnoozeNudgeDecision =
  | { readonly kind: "park"; readonly resetAtIso: string; readonly utilization: number }
  | {
      readonly kind: "stale";
      readonly observedAtIso: string;
      readonly utilization: number;
      readonly ageMinutes: number;
    }
  | { readonly kind: "none" };

/**
 * Decide whether/how to nudge. Pure.
 *
 * Order matters: a STALE feed is checked before PARK, because a park decision is
 * only trustworthy on a fresh reading — parking on a stale utilization would be
 * acting on data that no longer reflects the live window.
 *
 * - `prediction === null` → `none`. We have never seen the headers; staying
 *   silent avoids noise on a fresh setup (there is nothing to be stale about).
 * - reading older than `staleAfterMs` → `stale`, one-shot per `observedAtIso`.
 * - otherwise (fresh): `park` when `utilization ≥ threshold` and the reset is in
 *   the future. In ADVISORY mode (`enforce: false`) the park is one-shot per
 *   reset window (a single redirect). In ENFORCING mode (`enforce: true`) the
 *   one-shot is bypassed so park keeps firing every call until the agent parks
 *   or the window resets — the caller turns that into a persistent deny. Enforce
 *   never changes the `stale` path: a cold feed still only warns, never blocks.
 */
export function decideSnoozeNudge(
  prediction: LimitPrediction | null,
  state: SnoozeNudgeState,
  nowMs: number,
  threshold: number = DEFAULT_NUDGE_UTILIZATION,
  staleAfterMs: number = STALE_AFTER_MS,
  enforce = false,
): SnoozeNudgeDecision {
  if (prediction === null) return { kind: "none" };

  const observedMs = Date.parse(prediction.observedAtIso);
  if (Number.isFinite(observedMs) && nowMs - observedMs > staleAfterMs) {
    // Feed has gone cold — warn once for this exact stale reading (never enforce
    // on stale data: a hard block on a bad reading is worse than the blindness).
    if (state.staleWarnedForObservedIso === prediction.observedAtIso) return { kind: "none" };
    return {
      kind: "stale",
      observedAtIso: prediction.observedAtIso,
      utilization: prediction.fiveHour.utilization,
      ageMinutes: Math.round((nowMs - observedMs) / 60_000),
    };
  }

  // Fresh reading — the only state a park nudge may fire on.
  const { utilization, resetAtIso } = prediction.fiveHour;
  if (utilization < threshold || resetAtIso === null) return { kind: "none" };
  const resetMs = Date.parse(resetAtIso);
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) return { kind: "none" };
  // Advisory: one-shot per window. Enforcing: keep parking until the agent snoozes.
  if (!enforce && resetAtIso === state.nudgedForResetIso) return { kind: "none" };
  return { kind: "park", resetAtIso, utilization };
}

/**
 * The PARK instruction shown to the agent (as the PreToolUse deny reason) — the
 * document-and-hold pattern. Pure function of its inputs.
 */
export function snoozeNudgeReason(resetAtIso: string, utilization: number): string {
  const pct = Math.round(utilization * 100);
  return (
    `**Golem** You're near your usage limit (session window ~${pct}% used). ` +
    `Before it's exhausted, park in ONE call: the \`mcp__golem__snooze\` tool with ` +
    `\`until="${resetAtIso}"\` and \`note="<where you're up to + next steps>"\` — the ` +
    `note is filed as a durable local task before the wait starts, so your place ` +
    `survives even if the session ends. Then STOP — do not keep working. The session ` +
    `resumes here automatically when snooze completes.`
  );
}

/**
 * The ENFORCING park instruction (`enforce: true`): a hard redirect shown as the
 * PreToolUse deny reason. Unlike {@link snoozeNudgeReason} this repeats on every
 * non-snooze tool call until the agent parks, so it states plainly that snooze is
 * the only permitted action and how the user lifts enforcement. Pure.
 *
 * (Honest limit: a deny cannot stop the model spending tokens reacting to it —
 * this funnels the model to `snooze` fast, it is not a hard token freeze.)
 */
export function snoozeEnforceReason(resetAtIso: string, utilization: number): string {
  const pct = Math.round(utilization * 100);
  return (
    `**Golem** Usage-limit ENFORCEMENT is on and the session window is ~${pct}% used. ` +
    `The ONLY permitted action now is the \`mcp__golem__snooze\` tool ` +
    `(\`until="${resetAtIso}"\`) — every other tool is denied until you park or the ` +
    `window resets, so do NOT try to run \`golem task add\` first: pass ` +
    `\`note="<where you're up to + next steps>"\` to snooze instead and it files that ` +
    `durable task for you, before the wait. Call snooze now: your context is retained ` +
    `in-place and the session resumes automatically at reset. To lift enforcement, the ` +
    `user can set \`snooze.enforce\` false (env \`GOLEM_SNOOZE_ENFORCE=false\`).`
  );
}

/**
 * The STALE warning shown to the agent (as the PreToolUse deny reason). Fires
 * once when the rate-limit feed has gone cold so the blindness is visible rather
 * than silent. Pure function of its inputs.
 */
export function snoozeStaleReason(
  observedAtIso: string,
  utilization: number,
  ageMinutes: number,
): string {
  const pct = Math.round(utilization * 100);
  return (
    `**Golem** Heads up: the usage-limit auto-park is currently BLIND. Golem hasn't ` +
    `seen fresh \`anthropic-ratelimit-unified-*\` headers for ~${ageMinutes} min ` +
    `(last reading: session window ${pct}% at ${observedAtIso}). The most likely ` +
    `cause is that the active account/upstream doesn't emit those headers — e.g. an ` +
    `API-key account after an account switch. While blind, Golem cannot warn you as ` +
    `you approach the limit, so watch Claude Code's own limit indicator and park ` +
    `manually if needed. Check \`golem status\` (Limits line) and the active account ` +
    `(\`golem account\`). This is a one-time notice for this reading.`
  );
}

/** `.golem/state/snooze-nudge.json` for a project. */
export function snoozeNudgeStatePath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "snooze-nudge.json");
}

const stateSchema = z.object({
  nudgedForResetIso: z.string().optional(),
  staleWarnedForObservedIso: z.string().optional(),
});

/** Read the one-shot state, or `{}` (missing/corrupt → fail-open). */
export async function readSnoozeNudgeState(projectDir: string): Promise<SnoozeNudgeState> {
  let raw: string;
  try {
    raw = await readFile(snoozeNudgeStatePath(projectDir), "utf8");
  } catch {
    return {};
  }
  try {
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = stateSchema.safeParse(JSON.parse(stripped));
    if (!parsed.success) return {};
    // Normalize to omit absent keys (exactOptionalPropertyTypes: no `key: undefined`).
    const { nudgedForResetIso, staleWarnedForObservedIso } = parsed.data;
    return {
      ...(nudgedForResetIso !== undefined ? { nudgedForResetIso } : {}),
      ...(staleWarnedForObservedIso !== undefined ? { staleWarnedForObservedIso } : {}),
    };
  } catch {
    return {};
  }
}

/** Persist the one-shot state (atomic temp+rename in the state dir). */
export async function writeSnoozeNudgeState(
  projectDir: string,
  state: SnoozeNudgeState,
): Promise<void> {
  const file = snoozeNudgeStatePath(projectDir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}
