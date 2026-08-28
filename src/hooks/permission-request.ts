/**
 * R12.12 — PermissionRequest autonomy gate: answer the request, don't defer it.
 *
 * `src/hooks/pre-tool-use.ts` emits `ask` for `destructive`/`outward` at every
 * autonomy level (ADR-0002). R12.11 found what that leaves open: `ask` forces a
 * question, it does not answer one, so a permission dialog opens — and per the
 * channels reference a connected, permission-relay-capable channel is notified
 * "when a permission dialog opens". The relay's trigger is the dialog existing
 * at all (verification-notes §141).
 *
 * `PermissionRequest` is the event that can stand in for the dialog: the hooks
 * reference (re-read from the KB cache 2026-08-28, fetched 2026-08-22) says it
 * "Runs when Claude Code is about to ask you for permission", and that its
 * `decision` object is the only thing that "can grant or deny the request". A
 * `deny` here means no dialog is shown, and by construction nothing for a relay
 * to be notified of.
 *
 * This handler is deliberately a SECOND, EARLIER layer — `PreToolUse`'s `ask`
 * is untouched, and so are the audit log (`appendActionLog`) and pending-call
 * record (`recordPending`) it writes. This one writes nothing at all: it is a
 * pure decision, so it cannot double-count a call the `PreToolUse` pass already
 * logged, and it has no I/O to fail on at the moment a human is waiting.
 *
 * SAFETY: every failure path exits 0 with NO stdout → no decision object → the
 * native permission flow governs, exactly as it does today with no
 * `PermissionRequest` hook registered at all. No path ever emits `allow`.
 */

import {
  classifyAction,
  decidePermissionRequest,
  readAutonomyGateEnabled,
} from "../autonomy/index.js";
import { type HookIo, readAll } from "./hook-io.js";

/** The hooks-reference event name, echoed back in the decision envelope. */
export const PERMISSION_REQUEST_EVENT = "PermissionRequest";

/**
 * The subset of the documented payload this hook reads. `PermissionRequest`
 * carries `tool_name` / `tool_input` like `PreToolUse` but has NO `tool_use_id`;
 * `permission_suggestions` (the dialog's "always allow" options) is deliberately
 * ignored — echoing one back is how a hook grants a standing allow, which is the
 * opposite of what this gate exists to do.
 */
interface PermissionRequestPayload {
  readonly cwd?: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
}

export interface PermissionRequestOptions {
  readonly projectDir?: string;
  /** Inject the gate-enabled check (tests); default reads `.golem/state/autonomy.json`. */
  readonly readGateEnabled?: (projectDir: string) => Promise<boolean>;
}

function parsePayload(raw: string): PermissionRequestPayload | null {
  try {
    const j: unknown = JSON.parse(raw);
    if (typeof j !== "object" || j === null || Array.isArray(j)) return null;
    return j as PermissionRequestPayload;
  } catch {
    return null;
  }
}

/**
 * Run the PermissionRequest gate. Returns 0 always (fail-safe). Writes a
 * `decision` envelope to stdout ONLY for `destructive`/`outward` calls while the
 * autonomy gate is enabled; every other input produces no stdout.
 */
export async function runPermissionRequestHook(
  io: HookIo,
  options: PermissionRequestOptions = {},
): Promise<number> {
  try {
    const payload = parsePayload(await readAll(io.stdin));
    if (payload === null) return 0; // unparseable → native flow
    const toolName = payload.tool_name;
    if (typeof toolName !== "string" || toolName.length === 0) return 0;

    const projectDir = options.projectDir ?? payload.cwd ?? process.cwd();

    // Same toggle as the PreToolUse gate: `golem autonomy disable` turns BOTH
    // layers off together. A gate that could be disabled at one event and not
    // the other would be two policies wearing one switch.
    const gateEnabled = await (options.readGateEnabled ?? readAutonomyGateEnabled)(projectDir);
    if (!gateEnabled) return 0;

    const decision = decidePermissionRequest(classifyAction(toolName, payload.tool_input));
    if (decision === null) return 0; // not in the never-auto set → native flow

    io.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: PERMISSION_REQUEST_EVENT,
          decision: { behavior: decision.behavior, message: decision.message },
        },
      })}\n`,
    );
    return 0;
  } catch (err) {
    // Fail-safe: any crash → no decision object → native permission flow.
    // NEVER auto-allow.
    io.stderr.write(
      `golem hook permission-request: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 0;
  }
}
