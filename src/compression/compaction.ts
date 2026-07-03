/**
 * Compaction — the whitespace/log-noise-safe subset of the Golem-native
 * lossless stage (spec §4 level 1 "structural compaction"; Decision 18).
 *
 * Only transforms with zero semantic risk are allowed here:
 *   1. strip trailing spaces/tabs at the end of each line,
 *   2. collapse runs of 3+ consecutive newlines down to 2 (one blank line),
 *   3. strip trailing whitespace at the very end of the text.
 *
 * Applied ONLY to tool_result text (log-shaped machine output) — never to
 * tool_use blocks, thinking blocks, or assistant text (proxy fidelity hard
 * rule). Line-ending style (\n vs \r\n) is preserved.
 *
 * Prompt-cache stability (verification-notes.md §14) requires this to be a
 * PURE, versioned function: same input, same output, forever within a
 * version. Changing the algorithm invalidates previously cached prefixes, so
 * any change MUST bump COMPACTION_VERSION and be called out in the PR.
 */

/** Bump on ANY behavioral change to compactText (cache prefixes depend on it). */
export const COMPACTION_VERSION = 1;

/** Idempotent, pure lossless whitespace/log-noise compaction. */
export function compactText(text: string): string {
  // 1. Trailing spaces/tabs before a line break (keeps \n vs \r\n intact).
  let out = text.replace(/[ \t]+(?=\r?\n)/g, "");
  // 2. Runs of 3+ newlines -> exactly one blank line, preserving CRLF style
  //    when the run contains any CR.
  out = out.replace(/(?:\r?\n){3,}/g, (run) => (run.includes("\r") ? "\r\n\r\n" : "\n\n"));
  // 3. Trailing whitespace at the very end.
  out = out.replace(/[ \t\r\n]+$/, "");
  return out;
}
