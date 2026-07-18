/**
 * R5.4 — PreToolUse autonomy gate (WS-F4 / spec 20d).
 *
 * Classifies the pending tool call, reads the project's autonomy level, and
 * emits an allow/ask decision (or stays silent → native prompt). Threat model,
 * decision matrix, and default-deny proofs: ADR-0002. Verified hook I/O shape:
 * verification-notes §65 + the hooks reference (2026-07-16).
 *
 * SAFETY: every failure path exits 0 with NO stdout → Claude Code's native
 * permission flow (the human) governs. No path emits `allow` on error. We never
 * use exit 2 (which would hard-block), only exit 0 + optional JSON.
 */

import {
  type AutonomyLevel,
  appendActionLog,
  classifyAction,
  decideGate,
  decisionLabel,
  readAutonomyLevel,
} from "../autonomy/index.js";
import type { LimitPrediction } from "../proxy/limit-prediction.js";
import { readLimitState } from "../proxy/index.js";
import type { HookIo } from "./post-tool-use.js";
import {
  decideSnoozeNudge,
  readSnoozeNudgeState,
  snoozeNudgeReason,
  writeSnoozeNudgeState,
} from "./snooze-nudge.js";

interface PreToolUsePayload {
  readonly cwd?: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
  readonly session_id?: string;
}

export interface PreToolUseGateOptions {
  readonly projectDir?: string;
  readonly nowIso?: string;
  /** Inject the level reader (tests); default reads `.golem/state/autonomy.json`. */
  readonly readLevel?: (projectDir: string) => Promise<AutonomyLevel>;
  /** Inject the limit-prediction reader (tests); default reads `.golem/state/limit-state.json`. */
  readonly readPrediction?: (projectDir: string) => Promise<LimitPrediction | null>;
  /** Injected clock (epoch ms) for the snooze-nudge one-shot window check. */
  readonly now?: () => number;
}

async function readAll(stream: AsyncIterable<string | Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of stream) {
    out += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  }
  return out + decoder.decode();
}

function parsePayload(raw: string): PreToolUsePayload | null {
  try {
    const j: unknown = JSON.parse(raw);
    if (typeof j !== "object" || j === null || Array.isArray(j)) return null;
    return j as PreToolUsePayload;
  } catch {
    return null;
  }
}

/**
 * Run the gate. Returns 0 always (fail-safe). Writes the PreToolUse decision
 * JSON to stdout only when the gate emits allow/ask.
 */
export async function runPreToolUseHook(
  io: HookIo,
  options: PreToolUseGateOptions = {},
): Promise<number> {
  try {
    const payload = parsePayload(await readAll(io.stdin));
    if (payload === null) return 0; // unparseable → native prompt
    const toolName = payload.tool_name;
    if (typeof toolName !== "string" || toolName.length === 0) return 0;

    const projectDir = options.projectDir ?? payload.cwd ?? process.cwd();

    // Document-and-hold nudge (snooze P2b): as the session window fills, redirect
    // the agent to park (document into a durable task → snooze → wait) — ONCE per
    // reset window, before the autonomy gate. The snooze tool itself is exempt
    // (never deny the very call that does the parking).
    if (toolName !== "mcp__golem__snooze") {
      const readPrediction = options.readPrediction ?? readLimitState;
      const nowMs = options.now?.() ?? Date.now();
      const prediction = await readPrediction(projectDir);
      const nudged = await readSnoozeNudgeState(projectDir);
      const nudge = decideSnoozeNudge(prediction, nudged, nowMs);
      if (nudge.nudge && nudge.resetAtIso !== undefined && nudge.utilization !== undefined) {
        await writeSnoozeNudgeState(projectDir, nudge.resetAtIso);
        io.stdout.write(
          `${JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: snoozeNudgeReason(nudge.resetAtIso, nudge.utilization),
            },
          })}\n`,
        );
        return 0;
      }
    }

    const readLevel = options.readLevel ?? readAutonomyLevel;
    const level = await readLevel(projectDir);

    const action = classifyAction(toolName, payload.tool_input);
    const decision = decideGate(level, action);

    // Audit every decision, including silent defers (best-effort).
    await appendActionLog(projectDir, {
      ts: options.nowIso ?? new Date().toISOString(),
      tool: toolName,
      action,
      level,
      decision: decisionLabel(decision.emit),
      ...(payload.session_id !== undefined ? { sessionId: payload.session_id } : {}),
    });

    if (decision.emit === null) return 0; // defer to the human

    io.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: decision.emit,
          ...(decision.reason !== undefined ? { permissionDecisionReason: decision.reason } : {}),
        },
      })}\n`,
    );
    return 0;
  } catch (err) {
    // Fail-safe: any crash → no decision → native prompt. NEVER auto-allow.
    io.stderr.write(
      `golem hook pre-tool-use: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 0;
  }
}
