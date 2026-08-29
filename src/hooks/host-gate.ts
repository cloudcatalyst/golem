/**
 * R13.3 — `golem hook host-gate`: the gate that runs INSIDE a hosted session.
 *
 * Spawned by the runner as a `PreToolUse` hook, from settings the host injected
 * (`src/session/host-settings.ts` explains why the host supplies its own rather
 * than trusting the project's, and why `PreToolUse` rather than
 * `PermissionRequest`).
 *
 * ## How this differs from `pre-tool-use.ts`, which it deliberately does not reuse
 *
 * That handler is the GUEST gate. It carries the snooze park, the coder-first
 * nudge and the spawn gate, it writes the pending-call record that the blocked
 * read model renders, and its strongest move is `ask`. All of that is about
 * being a bystander in the developer's own session.
 *
 * This one runs in a session Golem spawned, where there is no human at the
 * terminal, no dialog to raise, and no reason to nudge anybody about anything.
 * Its whole job is: classify, decide, refuse if refusal is the answer, and write
 * an attributable line. Sharing an implementation would mean one function with a
 * mode flag deciding whether `ask` means "prompt the human" or "refuse because
 * nobody is there", which is two behaviours wearing one name.
 *
 * SAFETY, and note the direction is the OPPOSITE of the guest hook's:
 * `pre-tool-use.ts` fails to silence, because a crash there must leave the
 * human's own permission flow in charge. Here a crash must **deny**, because
 * there is no human flow to fall back to and the alternative is an unsupervised
 * tool call in a session Golem is answerable for.
 */

import { classifyAction, readAutonomyLevel } from "../autonomy/index.js";
import { decideHostGate, type HostGateDecision, resolveHostGate } from "../session/host-gate.js";
import { appendHostLog } from "../session/host-log.js";
import { type HookIo, readAll } from "./hook-io.js";

interface HostGatePayload {
  readonly cwd?: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
  readonly session_id?: string;
}

export interface HostGateHookOptions {
  readonly projectDir?: string;
  /** The hosted session id, from `--session` on the command line. */
  readonly sessionId?: string;
  readonly nowIso?: string;
  readonly readLevel?: (projectDir: string) => Promise<string>;
}

function parsePayload(raw: string): HostGatePayload | null {
  try {
    const j: unknown = JSON.parse(raw);
    if (typeof j !== "object" || j === null || Array.isArray(j)) return null;
    return j as HostGatePayload;
  } catch {
    return null;
  }
}

/** The `PreToolUse` deny envelope — FLAT `permissionDecision`, not the nested one. */
function denyEnvelope(reason: string): string {
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  })}\n`;
}

/**
 * A refusal used when the gate itself could not run — a malformed payload, an
 * unreadable project, a crash. Deliberately fail-CLOSED (see the module header).
 */
const GATE_FAILED_REASON =
  "Refused by the Golem session host: the host gate could not evaluate this call, so it was denied rather than run unsupervised. This is a fail-closed refusal, not a policy decision about the action itself.";

/**
 * Run the host gate. Always returns 0 — a non-zero exit is not how a refusal is
 * expressed here, and exit 2 would hard-block the session rather than refuse one
 * call.
 */
export async function runHostGateHook(
  io: HookIo,
  options: HostGateHookOptions = {},
): Promise<number> {
  try {
    const payload = parsePayload(await readAll(io.stdin));
    if (payload === null) {
      io.stdout.write(denyEnvelope(GATE_FAILED_REASON));
      return 0;
    }
    const toolName = payload.tool_name;
    if (typeof toolName !== "string" || toolName.length === 0) {
      io.stdout.write(denyEnvelope(GATE_FAILED_REASON));
      return 0;
    }

    const projectDir = options.projectDir ?? payload.cwd ?? process.cwd();
    const sessionId = options.sessionId ?? payload.session_id ?? "unknown";
    const action = classifyAction(toolName, payload.tool_input);

    const level = await (options.readLevel ?? readAutonomyLevel)(projectDir);
    const decided: HostGateDecision = decideHostGate(
      level as Parameters<typeof decideHostGate>[0],
      action,
    );
    // R13.3 ships no answerer: there is no device transport (R13.5) and no chat
    // surface (R13.6) yet, so an `ask` has nobody to reach and resolves to a
    // refusal rather than a wait. The seam is `HostAttachment`.
    const resolved = resolveHostGate(decided);

    // Attribution is written for EVERY decision, allow included — an audit log
    // that only records refusals cannot answer "what did this session do".
    await appendHostLog(projectDir, {
      kind: "decision",
      ts: options.nowIso ?? new Date().toISOString(),
      sessionId,
      tool: toolName,
      action,
      decision: resolved.decision,
      reason: resolved.reason,
    }).catch(() => {
      // Best-effort: losing a log line must not turn an allowed call into a
      // denied one. The refusal path below still writes its envelope.
    });

    if (resolved.decision === "deny") {
      io.stdout.write(denyEnvelope(resolved.reason));
      return 0;
    }

    // `allow` emits NOTHING rather than `permissionDecision: "allow"`. Emitting
    // allow would remove prompts the runner would otherwise raise — widening
    // authority beyond what the matrix granted. Silence lets the runner's own
    // flow govern, which is the same thing the guest gate's `null` means.
    return 0;
  } catch (err) {
    io.stderr.write(`golem hook host-gate: ${err instanceof Error ? err.message : String(err)}\n`);
    io.stdout.write(denyEnvelope(GATE_FAILED_REASON));
    return 0;
  }
}
