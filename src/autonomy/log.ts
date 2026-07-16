/**
 * R5.4 — the auditable action log (ADR-0002 requirement).
 *
 * Every decision the gate emits is appended (JSONL) to
 * `<project>/.golem/state/autonomy-log.jsonl` so an autonomous run is fully
 * reviewable after the fact. Best-effort: a log-write failure must never change
 * the gate decision the agent is waiting on.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ActionClass } from "./classify.js";
import type { GateEmission } from "./gate.js";
import type { AutonomyLevel } from "./policy.js";

export interface ActionLogEntry {
  readonly ts: string;
  readonly tool: string;
  readonly action: ActionClass;
  readonly level: AutonomyLevel;
  /** What the gate emitted: allow / ask / defer (null → "defer"). */
  readonly decision: "allow" | "ask" | "defer";
  readonly sessionId?: string;
}

export function actionLogPath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "autonomy-log.jsonl");
}

/** Map a gate emission to the logged decision label. */
export function decisionLabel(emit: GateEmission): ActionLogEntry["decision"] {
  return emit === null ? "defer" : emit;
}

/** Append one decision. Never throws. */
export async function appendActionLog(projectDir: string, entry: ActionLogEntry): Promise<void> {
  try {
    const file = actionLogPath(projectDir);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // an audit line is never worth failing the gate over
  }
}

/** Read the most recent `limit` log entries, newest last. Never throws. */
export async function readActionLog(projectDir: string, limit = 50): Promise<ActionLogEntry[]> {
  try {
    const raw = await readFile(actionLogPath(projectDir), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const tail = lines.slice(-limit);
    const out: ActionLogEntry[] = [];
    for (const line of tail) {
      try {
        out.push(JSON.parse(line) as ActionLogEntry);
      } catch {
        // skip a corrupt line
      }
    }
    return out;
  } catch {
    return [];
  }
}
