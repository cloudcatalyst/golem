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
 * Decision logic drafted with the local `coder` model, then hardened here
 * (atomic cross-platform I/O, fail-open) to match `limit-prediction.ts`.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LimitPrediction } from "../proxy/limit-prediction.js";

/** Session-window utilization at/above which the gate nudges the agent to park. */
export const DEFAULT_NUDGE_UTILIZATION = 0.9;

/** Outcome of a nudge decision. `nudge:false` → the gate stays silent. */
export interface SnoozeNudgeDecision {
  readonly nudge: boolean;
  /** The session-window reset (ISO) to snooze until — present only when nudging. */
  readonly resetAtIso?: string;
  /** The observed 0..1 utilization — present only when nudging. */
  readonly utilization?: number;
}

/**
 * Decide whether to nudge. Pure. Nudges when the session (5h) window is at/above
 * `threshold`, its reset is in the future, and we have NOT already nudged for
 * this exact reset window (one-shot). Anything missing → no nudge.
 */
export function decideSnoozeNudge(
  prediction: LimitPrediction | null,
  alreadyNudgedResetIso: string | undefined,
  nowMs: number,
  threshold: number = DEFAULT_NUDGE_UTILIZATION,
): SnoozeNudgeDecision {
  if (prediction === null) return { nudge: false };
  const { utilization, resetAtIso } = prediction.fiveHour;
  if (utilization < threshold || resetAtIso === null) return { nudge: false };
  const resetMs = Date.parse(resetAtIso);
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) return { nudge: false };
  if (resetAtIso === alreadyNudgedResetIso) return { nudge: false }; // one-shot per window
  return { nudge: true, resetAtIso, utilization };
}

/**
 * The instruction shown to the agent (as the PreToolUse deny reason) — the
 * document-and-hold pattern. Pure function of its inputs.
 */
export function snoozeNudgeReason(resetAtIso: string, utilization: number): string {
  const pct = Math.round(utilization * 100);
  return (
    `**Golem** You're near your usage limit (session window ~${pct}% used). ` +
    `Before it's exhausted: (1) capture your current progress as a durable task ` +
    `with \`golem task add "<where you're up to + next steps>"\`, then (2) call the ` +
    `\`mcp__golem__snooze\` tool with \`until="${resetAtIso}"\` to park until the ` +
    `window resets, then (3) STOP — do not keep working. The session resumes here ` +
    `automatically when snooze completes.`
  );
}

/** `.golem/state/snooze-nudge.json` for a project. */
export function snoozeNudgeStatePath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "snooze-nudge.json");
}

const stateSchema = z.object({ nudgedForResetIso: z.string() });

/** Read the reset we last nudged for, or undefined (missing/corrupt → fail-open). */
export async function readSnoozeNudgeState(projectDir: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(snoozeNudgeStatePath(projectDir), "utf8");
  } catch {
    return undefined;
  }
  try {
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = stateSchema.safeParse(JSON.parse(stripped));
    return parsed.success ? parsed.data.nudgedForResetIso : undefined;
  } catch {
    return undefined;
  }
}

/** Record the reset we just nudged for (atomic temp+rename in the state dir). */
export async function writeSnoozeNudgeState(projectDir: string, resetAtIso: string): Promise<void> {
  const file = snoozeNudgeStatePath(projectDir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ nudgedForResetIso: resetAtIso }, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}
