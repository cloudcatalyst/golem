/**
 * R12.2 — the ONE argument a human must judge for a pending tool call.
 *
 * A permission prompt is a question about a specific thing: a shell command, a
 * file path, a URL. `tool_input` is a whole object, most of which is noise to
 * someone deciding whether to approve — and ADR-0006 §2 requires that an
 * `unknown`-class command reach a remote screen as **full text, never a
 * summary**, so this picks a field verbatim rather than describing it.
 *
 * Kept separate from `session-state.ts` so the read model has no opinion about
 * Claude Code's tool schemas, and separate from `classify.ts` so the autonomy
 * classifier is not entangled with a display concern.
 *
 * The result is **not** redacted here — `writePendingToolCall` redacts on the way
 * to disk, so there is exactly one choke point rather than two places to forget.
 */

import { isRecord } from "../shared/json.js";

/** Longest argument recorded. Beyond this the tail is elided, visibly. */
export const MAX_ARGUMENT_CHARS = 2_000;

const TRUNCATED_SUFFIX = " …[truncated]";

/**
 * Per-tool field preference. First present non-empty string wins.
 *
 * The fallback list is deliberately generic: a tool this table has never heard
 * of (an MCP tool from another server, a new built-in) still yields something
 * recognisable instead of nothing.
 */
const PREFERENCES: Readonly<Record<string, readonly string[]>> = {
  Bash: ["command"],
  BashOutput: ["command"],
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  NotebookEdit: ["file_path"],
  WebFetch: ["url", "query"],
  WebSearch: ["query", "url"],
  Glob: ["pattern"],
  Grep: ["pattern"],
  Task: ["description"],
  Agent: ["description"],
};

const FALLBACK: readonly string[] = [
  "command",
  "file_path",
  "url",
  "path",
  "query",
  "pattern",
  "prompt",
];

/**
 * The argument to show, or undefined when the input carries nothing usable.
 *
 * Falls back to the serialized input rather than to undefined: "we cannot tell
 * you what this is" is a worse answer for someone holding a permission prompt
 * than an ugly one.
 */
export function toolArgument(toolName: string, toolInput: unknown): string | undefined {
  if (!isRecord(toolInput)) return undefined;
  for (const key of PREFERENCES[toolName] ?? FALLBACK) {
    const value = toolInput[key];
    if (typeof value === "string" && value !== "") return cap(value);
  }
  const serialized = safeStringify(toolInput);
  return serialized === undefined ? undefined : cap(serialized);
}

function cap(text: string): string {
  return text.length <= MAX_ARGUMENT_CHARS
    ? text
    : `${text.slice(0, MAX_ARGUMENT_CHARS)}${TRUNCATED_SUFFIX}`;
}

function safeStringify(value: unknown): string | undefined {
  try {
    const out = JSON.stringify(value);
    return out === undefined || out === "{}" ? undefined : out;
  } catch {
    // circular / unserializable — nothing worth showing
    return undefined;
  }
}
