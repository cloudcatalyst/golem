/**
 * Decision 21b groundwork — the Notification / UserPromptSubmit hook handlers.
 *
 * - Notification fires when Claude Code is waiting on the human (permission
 *   prompt, question, idle) → record blocked-state with the message.
 * - UserPromptSubmit fires when the human submits a prompt → they've responded,
 *   so clear the blocked-state.
 *
 * Both read `cwd` from the hook stdin JSON (like the PostToolUse hook), write
 * nothing to stdout (no behavior change), and always resolve exit 0 — fail-safe,
 * so a state-tracking hook can never disrupt a session.
 */

import type { HookIo } from "./post-tool-use.js";
import { markBlocked, markUnblocked } from "./session-state.js";

async function readAll(stream: AsyncIterable<string | Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of stream) {
    out += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  }
  return out + decoder.decode();
}

interface Payload {
  readonly cwd?: string;
  readonly message?: string;
  readonly session_id?: string;
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
    };
  } catch {
    return {};
  }
}

/** Notification handler: record that the session is blocked on the human. */
export async function runNotificationHook(io: HookIo, nowIso: string): Promise<number> {
  try {
    const p = parsePayload(await readAll(io.stdin));
    const dir = p.cwd ?? process.cwd();
    await markBlocked(dir, p.message ?? "waiting for input", nowIso, p.session_id);
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
    await markUnblocked(dir, nowIso);
  } catch {
    // fail-safe
  }
  return 0;
}
