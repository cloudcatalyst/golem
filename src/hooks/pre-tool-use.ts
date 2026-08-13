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
  readAutonomyGateEnabled,
  readAutonomyLevel,
} from "../autonomy/index.js";
import { loadConfig } from "../config/index.js";
// `../proxy/limit-prediction.js`, not the `../proxy/index.js` barrel: the barrel
// reaches server.ts, which imports `undici` (~270ms). This hook runs on EVERY
// Claude Code tool call and only reads a JSON file. See verification-notes §86.
import { type LimitPrediction, readLimitState } from "../proxy/limit-prediction.js";
import {
  coderFirstNudgeReason,
  decideCoderFirstNudge,
  isCodeDraftTarget,
  readCoderFirstNudgeState,
  writeCoderFirstNudgeState,
} from "./coder-first-nudge.js";
import { guidanceEnabled } from "./guidance.js";
import { type HookIo, readAll } from "./hook-io.js";
import {
  decideSnoozeNudge,
  readSnoozeNudgeState,
  snoozeEnforceReason,
  snoozeNudgeReason,
  snoozeStaleReason,
  writeSnoozeNudgeState,
} from "./snooze-nudge.js";

/**
 * Whether the snooze document-and-hold park is ENFORCING (persistent deny) vs
 * ADVISORY (one-shot). Reads `snooze.enforce` from the effective config (default
 * true, env `GOLEM_SNOOZE_ENFORCE` overrides). Fail-open to false even though the
 * default is true: erroring into a session-wide hard block is worse than briefly
 * degrading to advisory, so a config-read failure never blocks every tool call.
 */
async function readSnoozeEnforced(projectDir: string): Promise<boolean> {
  try {
    const { settings } = await loadConfig({ projectDir });
    return settings.snooze.enforce;
  } catch {
    return false;
  }
}

/**
 * Tools the usage-limit park never denies — the escape hatch that makes parking
 * reachable (R9.23).
 *
 * `mcp__golem__snooze` has always been exempt: denying the very call that does
 * the parking would be self-defeating. The other two were added after the deny
 * deadlocked live twice (2026-08-10, 2026-08-13):
 *
 * - **`ToolSearch`** — `snooze` is a DEFERRED tool, so calling it first requires
 *   loading its schema, and the only way to do that is `ToolSearch`. Denying it
 *   means the sole permitted tool cannot be called. This is general: any deferred
 *   tool needed for parking has the same shape.
 * - **`mcp__golem__expand`** — the way back from a CCR reference. R9.23 also stops
 *   tool schemas being elided in the first place
 *   (`DEDUP_EXEMPT_TOOLS` in `src/compression/native-lossless.ts`), but the two
 *   fixes are independent on purpose: whenever the agent's only route to parking
 *   runs through a reference, the tool that resolves references must not be the
 *   thing standing in the way.
 *
 * None of the three spends meaningful budget, which is what makes exempting them
 * safe: the park exists to stop the session burning through a limit, and reading
 * one tool schema is not how that happens.
 */
export const PARK_EXEMPT_TOOLS: readonly string[] = [
  "mcp__golem__snooze",
  "ToolSearch",
  "mcp__golem__expand",
];

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
  /** Inject the guidance-active check (tests); default reads `.claude/rules/`. */
  readonly isGuidanceEnabled?: (projectDir: string, name: string) => Promise<boolean>;
  /** Inject the gate-enabled check (tests); default reads `.golem/state/autonomy.json`. */
  readonly readGateEnabled?: (projectDir: string) => Promise<boolean>;
  /** Inject the snooze-enforce check (tests); default reads `snooze.enforce` config. */
  readonly isSnoozeEnforced?: (projectDir: string) => Promise<boolean>;
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
    // reset window, before the autonomy gate. A short list of tools is exempt, so
    // the park stays reachable rather than becoming a deadlock — see
    // PARK_EXEMPT_TOOLS for why each one is on it.
    if (!PARK_EXEMPT_TOOLS.includes(toolName)) {
      const readPrediction = options.readPrediction ?? readLimitState;
      const nowMs = options.now?.() ?? Date.now();
      const prediction = await readPrediction(projectDir);
      const state = await readSnoozeNudgeState(projectDir);
      const enforce = await (options.isSnoozeEnforced ?? readSnoozeEnforced)(projectDir);
      const nudge = decideSnoozeNudge(prediction, state, nowMs, undefined, undefined, enforce);
      const emitDeny = (reason: string): void => {
        io.stdout.write(
          `${JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: reason,
            },
          })}\n`,
        );
      };
      if (nudge.kind === "park") {
        if (enforce) {
          // Enforcing: deny every non-snooze call until the agent parks. Do NOT
          // write the one-shot marker — the block must persist, not consume itself.
          emitDeny(snoozeEnforceReason(nudge.resetAtIso, nudge.utilization));
        } else {
          // Advisory: a single redirect per window. Preserve any stale marker.
          await writeSnoozeNudgeState(projectDir, {
            ...state,
            nudgedForResetIso: nudge.resetAtIso,
          });
          emitDeny(snoozeNudgeReason(nudge.resetAtIso, nudge.utilization));
        }
        return 0;
      }
      if (nudge.kind === "stale") {
        // Warn once that the rate-limit feed has gone cold (auto-park is blind).
        await writeSnoozeNudgeState(projectDir, {
          ...state,
          staleWarnedForObservedIso: nudge.observedAtIso,
        });
        emitDeny(snoozeStaleReason(nudge.observedAtIso, nudge.utilization, nudge.ageMinutes));
        return 0;
      }
    }

    // Coder-first enforcement (Decision 39): when the `coder-first` guidance is
    // active, DENY the first non-trivial hand-written code Write/Edit of a
    // session and redirect the agent to draft with `coder` first — ONCE per
    // session. "Enforced if guided": skipped entirely when the guidance is off.
    const codeTarget = isCodeDraftTarget(toolName, payload.tool_input);
    if (codeTarget.isCode) {
      const guided = options.isGuidanceEnabled ?? guidanceEnabled;
      if (await guided(projectDir, "coder-first")) {
        const nudgedSessions = await readCoderFirstNudgeState(projectDir);
        const decision = decideCoderFirstNudge(codeTarget, nudgedSessions, payload.session_id);
        if (decision.nudge && decision.sessionKey !== undefined) {
          await writeCoderFirstNudgeState(projectDir, decision.sessionKey);
          io.stdout.write(
            `${JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: coderFirstNudgeReason(),
              },
            })}\n`,
          );
          return 0;
        }
      }
    }

    // The autonomy gate (ADR-0002) is a SEPARATE toggle from the shared hook:
    // enabled by default, but `golem autonomy disable` turns it off without
    // losing the snooze/coder-first nudges above. Disabled → emit nothing, so
    // Claude Code's native permission flow (allow-list + prompts) governs.
    const gateEnabled = await (options.readGateEnabled ?? readAutonomyGateEnabled)(projectDir);
    if (!gateEnabled) return 0;

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
