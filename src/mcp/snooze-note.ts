/**
 * Snooze park notes — persisting "where you're up to" as part of parking.
 *
 * The park procedure used to be two acts: `golem task add "<note>"` through Bash,
 * then the `snooze` MCP tool. Decision 45 made snooze enforcement the default, and
 * enforcement denies every non-`snooze` tool call — so step 1 was denied by step 2's
 * own mechanism (task `snooze-taskadd`, observed live 2026-07-30). Exempting the
 * `Bash` call would have re-opened the hole enforcement exists to close, matched on
 * a command string.
 *
 * Instead `snooze` persists the note itself, which makes the ordering problem
 * structurally impossible rather than exempted: parking and documenting are one
 * call, and the only permitted tool is the one that writes the safety net.
 *
 * The note becomes an ordinary **local** task under `.golem/tasks/<uuid>.json` —
 * the same shape `golem task add` writes, so `golem task list` / `show` / `done`
 * all work on it unchanged.
 */

import { FileTaskStore } from "../tasks/store.js";
import { createTask } from "../tasks/types.js";

/** Max length of the derived one-line title (matches `taskTitle` in cli/task.ts). */
const TITLE_MAX = 60;

/** Outcome of a note write. Never throws — a failure is data, not an exception. */
export type SnoozeNoteResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly error: string };

/**
 * First line of `note`, truncated for display. Mirrors `taskTitle`'s 60/57+ellipsis
 * rule so a snooze note renders identically to a hand-added task.
 */
export function snoozeNoteTitle(note: string): string {
  const firstLine = (note.split("\n", 1)[0] ?? "").trim();
  return firstLine.length > TITLE_MAX ? `${firstLine.slice(0, TITLE_MAX - 3)}…` : firstLine;
}

/**
 * Write `note` as a queued local task under `projectDir`.
 *
 * Fail-open by contract: any error (unwritable state dir, read-only checkout) is
 * returned as `{ ok: false }` so the caller can still park. Losing the wait
 * because the note could not be filed would be worse than losing the note — and
 * the caller echoes an unpersisted note back into the transcript rather than
 * dropping it silently.
 */
export async function persistSnoozeNote(
  projectDir: string,
  note: string,
  opts: { readonly nowIso?: string } = {},
): Promise<SnoozeNoteResult> {
  try {
    const trimmed = note.trim();
    if (trimmed.length === 0) return { ok: false, error: "note is empty" };
    const title = snoozeNoteTitle(trimmed);
    const nowIso = opts.nowIso ?? new Date().toISOString();
    const task = createTask({ prompt: trimmed, ...(title.length > 0 ? { title } : {}) }, nowIso);
    const stored = await new FileTaskStore(projectDir).put(task, nowIso);
    return { ok: true, id: stored.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
