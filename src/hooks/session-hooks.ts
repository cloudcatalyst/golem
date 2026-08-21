/**
 * Decision 21b / R12.2 — the Notification / UserPromptSubmit hook handlers.
 *
 * - Notification fires when Claude Code wants the human's attention → record the
 *   blocked read model (`src/hooks/session-state.ts`): which project, which
 *   session, what kind of block, and — for a permission request — the tool and
 *   the argument the human must judge.
 * - UserPromptSubmit fires when the human submits a prompt → they've responded,
 *   so clear the blocked state with `lastEvent: "responded"`.
 *
 * ## Where the tool name comes from
 *
 * Not from this payload. Verified 2026-08-21 against
 * https://code.claude.com/docs/en/hooks#notification: a Notification hook
 * receives `message`, an optional `title` and `notification_type`, and the docs'
 * own example message is the entirely generic `"Claude needs your permission"`.
 * No `tool_name`, no `tool_input`. The same page records that `permission_prompt`
 * fires about six seconds *after* the prompt appears — so by the time we are
 * called, the PreToolUse hook has already seen the real tool call and stashed it
 * as a {@link PendingToolCall}. This handler correlates the two.
 *
 * Both handlers read `cwd` from the hook stdin JSON (like the PostToolUse hook),
 * write nothing to stdout (no behavior change), and always resolve exit 0 —
 * fail-safe, so a state-tracking hook can never disrupt a session.
 */

import { type HookIo, readAll } from "./hook-io.js";
import {
  type BlockDetails,
  type BlockedTool,
  type BlockKind,
  markBlocked,
  markUnblocked,
  PENDING_TOOL_MAX_AGE_MS,
  readPendingToolCall,
} from "./session-state.js";

interface Payload {
  readonly cwd?: string;
  readonly message?: string;
  readonly session_id?: string;
  /** R12.2 — the authoritative block kind, when the client sends one. */
  readonly notification_type?: string;
}

function parsePayload(raw: string): Payload {
  try {
    const j: unknown = JSON.parse(raw);
    if (typeof j !== "object" || j === null) return {};
    const o = j as Record<string, unknown>;
    return {
      ...(typeof o.cwd === "string" ? { cwd: o.cwd } : {}),
      ...(typeof o.message === "string" ? { message: o.message } : {}),
      ...(typeof o.session_id === "string" ? { session_id: o.session_id } : {}),
      ...(typeof o.notification_type === "string"
        ? { notification_type: o.notification_type }
        : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Which `notification_type` values mean "the session is waiting on the human",
 * and which kind of waiting. Values verified 2026-08-21 (hooks reference).
 */
const BLOCKING_TYPES: Readonly<Record<string, BlockKind>> = {
  permission_prompt: "permission",
  idle_prompt: "idle",
  agent_needs_input: "question",
  elicitation_dialog: "question",
  elicitation_url_dialog: "question",
};

/**
 * Notification types that are NOT a block: an auth confirmation, an elicitation
 * that has already been answered, or a *background* session finishing. Before
 * R12.2 every notification set `blocked: true`, so `auth_success` alone could
 * light up a "waiting" indicator with nothing waiting.
 */
const NON_BLOCKING_TYPES: readonly string[] = [
  "auth_success",
  "elicitation_complete",
  "elicitation_response",
  "agent_completed",
];

interface NotificationClass {
  readonly block: boolean;
  readonly kind?: BlockKind;
}

/**
 * Classify a notification. An unrecognised or absent `notification_type` (an
 * older client, or a type added after this was written) is still treated as a
 * block, with the kind guessed from the message text — degrading to the
 * pre-R12.2 behaviour rather than to silence.
 */
export function classifyNotification(
  notificationType: string | undefined,
  message: string | undefined,
): NotificationClass {
  if (notificationType !== undefined) {
    const kind = BLOCKING_TYPES[notificationType];
    if (kind !== undefined) return { block: true, kind };
    if (NON_BLOCKING_TYPES.includes(notificationType)) return { block: false };
  }
  const text = (message ?? "").toLowerCase();
  if (text === "") return { block: true };
  if (text.includes("permission")) return { block: true, kind: "permission" };
  if (text.includes("waiting for your input") || text.includes("idle")) {
    return { block: true, kind: "idle" };
  }
  return { block: true, kind: "question" };
}

/**
 * The pending tool call, if it is recent enough and belongs to this session.
 *
 * Only ever attached to a `permission` block: for an idle turn or a plain
 * question there is no tool call under judgement, and naming the last one would
 * invent a question the human was never asked.
 */
async function correlateTool(
  dir: string,
  kind: BlockKind | undefined,
  sessionId: string | undefined,
  nowIso: string,
): Promise<BlockedTool | undefined> {
  if (kind !== "permission") return undefined;
  const pending = await readPendingToolCall(dir);
  if (pending === null) return undefined;
  // A different session's pending call is never this session's question. An
  // absent id on either side is treated as "cannot rule it out".
  if (sessionId !== undefined && pending.sessionId !== undefined && pending.sessionId !== sessionId)
    return undefined;
  const now = Date.parse(nowIso);
  const then = Date.parse(pending.ts);
  if (Number.isFinite(now) && Number.isFinite(then)) {
    const age = now - then;
    if (age < 0 || age > PENDING_TOOL_MAX_AGE_MS) return undefined;
  }
  return {
    name: pending.name,
    ...(pending.argument !== undefined ? { argument: pending.argument } : {}),
    ...(pending.actionClass !== undefined ? { actionClass: pending.actionClass } : {}),
  };
}

/** Notification handler: record that the session is blocked on the human. */
export async function runNotificationHook(io: HookIo, nowIso: string): Promise<number> {
  try {
    const p = parsePayload(await readAll(io.stdin));
    const dir = p.cwd ?? process.cwd();
    const { block, kind } = classifyNotification(p.notification_type, p.message);
    if (!block) return 0; // not a block — do not light up a "waiting" indicator
    const tool = await correlateTool(dir, kind, p.session_id, nowIso);
    const details: BlockDetails = {
      ...(kind !== undefined ? { kind } : {}),
      ...(tool !== undefined ? { tool } : {}),
    };
    await markBlocked(dir, p.message ?? "waiting for input", nowIso, p.session_id, details);
  } catch {
    // fail-safe
  }
  return 0;
}

/** UserPromptSubmit handler: the human responded → clear the blocked flag. */
export async function runUserPromptSubmitHook(io: HookIo, nowIso: string): Promise<number> {
  try {
    const p = parsePayload(await readAll(io.stdin));
    const dir = p.cwd ?? process.cwd();
    await markUnblocked(dir, nowIso, p.session_id);
  } catch {
    // fail-safe
  }
  return 0;
}
