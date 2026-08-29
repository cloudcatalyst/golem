/**
 * R13.3 — the hosted-session audit log: attribution before delivery.
 *
 * ADR-0007 invariant 4 says a turn nobody can attribute must not run. So every
 * relayed turn is written here **before** it is handed to the runner, and every
 * tool decision the host makes is written here as it is made.
 *
 * ## Why this is not `src/autonomy/log.ts`
 *
 * That log is tool-call shaped (`tool`, `action`, `level`, `decision`) and its
 * `decision` union is `allow | ask | defer` — the three things a *guest hook*
 * can emit. It is written from inside someone else's session by a hook process.
 *
 * This log records a different kind of fact: who said what, to which hosted
 * session, at what time, and what the host did about the tool calls that
 * followed. Squeezing turns into a tool-shaped record would mean a `tool` field
 * holding `"(turn)"`, and widening that union with `deny` would tell every
 * existing reader that guest hooks can now refuse — which they cannot. Two
 * logs, because there are two relationships. See `host-gate.ts` for the same
 * argument about the decision type.
 *
 * Append-only JSONL, one file per project, bounded by line count so a long-lived
 * session cannot fill a disk.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HostDecision } from "./host-gate.js";

/** Keep the newest N lines. A session's audit trail, not an archive. */
export const HOST_LOG_MAX_LINES = 5_000;

export function hostLogPath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "host-log.jsonl");
}

/** A turn relayed INTO a hosted session — written before the runner sees it. */
export interface HostTurnEntry {
  readonly kind: "turn";
  readonly ts: string;
  readonly sessionId: string;
  /**
   * Who authored it: a device id, or `"local"` for the CLI/dashboard. Never
   * optional — an unattributable turn is exactly what invariant 4 forbids.
   */
  readonly origin: string;
  /** The exact text relayed. Redacted transcripts live in the conversation store; this is the audit copy. */
  readonly text: string;
}

/** A tool call the host decided about. */
export interface HostDecisionEntry {
  readonly kind: "decision";
  readonly ts: string;
  readonly sessionId: string;
  readonly tool: string;
  readonly action: string;
  readonly decision: HostDecision;
  readonly reason: string;
}

/** A lifecycle event: started, stopped, crashed, parked. */
export interface HostLifecycleEntry {
  readonly kind: "lifecycle";
  readonly ts: string;
  readonly sessionId: string;
  readonly event: "started" | "stopped" | "crashed" | "parked" | "attached" | "detached";
  readonly detail?: string;
}

export type HostLogEntry = HostTurnEntry | HostDecisionEntry | HostLifecycleEntry;

/**
 * Append one entry. Awaited by callers that must not proceed until it lands —
 * notably {@link HostTurnEntry}, whose whole point is that it is written first.
 */
export async function appendHostLog(projectDir: string, entry: HostLogEntry): Promise<void> {
  const file = hostLogPath(projectDir);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
}

/** Newest last. A malformed line is skipped rather than failing the read. */
export async function readHostLog(
  projectDir: string,
  limit = 200,
): Promise<readonly HostLogEntry[]> {
  let raw: string;
  try {
    raw = await readFile(hostLogPath(projectDir), "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  const out: HostLogEntry[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(line) as HostLogEntry);
    } catch {
      // A truncated final line (a kill mid-append) is expected, not exceptional.
    }
  }
  return out;
}

/**
 * Trim to {@link HOST_LOG_MAX_LINES}. Called opportunistically rather than on
 * every append: rewriting the file per turn would turn an append-only log into
 * a read-modify-write on the hot path.
 */
export async function trimHostLog(projectDir: string): Promise<void> {
  const file = hostLogPath(projectDir);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return;
  }
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  if (lines.length <= HOST_LOG_MAX_LINES) return;
  await writeFile(file, `${lines.slice(-HOST_LOG_MAX_LINES).join("\n")}\n`, "utf8");
}
