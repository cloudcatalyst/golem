/**
 * The two lines the hooks call, and the promise that they are harmless.
 *
 * Capture runs on the path of every Edit and every prompt. It is a convenience —
 * a style guide that learns — and it may never be the reason an edit fails, a
 * prompt is delayed, or a hook writes something to stdout. So both entry points
 * here swallow everything, return void, and do nothing at all outside a Golem
 * project.
 *
 * Keeping this adapter separate from `capture.ts` keeps that guarantee in one
 * readable place, rather than as a `try` around each call site in the hooks.
 */

import { readFile } from "node:fs/promises";
import { isWriteTool, recordAgentWrite, sweepCorrections, writeTargetPath } from "./capture.js";
import { openVibeStore } from "./store.js";

/**
 * PostToolUse: the agent just wrote a file.
 *
 * Sweeps THAT FILE first, then re-baselines it. The order matters: if the human
 * corrected the file and the agent then wrote to it again, recording the new
 * write first would overwrite the baseline and the correction would be lost.
 * Sweeping one named file is a single read, which is what makes it affordable
 * here — the full sweep belongs on the prompt boundary.
 */
export async function captureAfterWrite(
  toolName: string | undefined,
  toolInput: unknown,
  cwd: string,
  nowIso: string,
): Promise<void> {
  try {
    if (!isWriteTool(toolName)) return;
    const target = writeTargetPath(toolInput);
    if (target === null) return;

    const store = openVibeStore({ cwd });
    if (store === null) return; // not a Golem project — the gate

    await sweepCorrections(cwd, store, nowIso, [target]);
    const content = await readFile(target, "utf8");
    await recordAgentWrite(cwd, target, content, nowIso);
  } catch {
    // Never the reason an edit fails.
  }
}

/**
 * UserPromptSubmit: the human has stopped typing, which means they have
 * probably stopped editing.
 *
 * This is the moment the out-of-band edits are visible, and the reason capture
 * does not need a file watcher to see them. It is also naturally rate-limited —
 * once per human message, not once per keystroke.
 */
export async function captureOnPrompt(cwd: string, nowIso: string): Promise<void> {
  try {
    const store = openVibeStore({ cwd });
    if (store === null) return;
    await sweepCorrections(cwd, store, nowIso);
  } catch {
    // Never the reason a prompt is delayed.
  }
}
