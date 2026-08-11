/**
 * Coder-first enforcement trigger (spec Decision 39). The soft `coder-first`
 * guidance ("draft non-trivial code with the `coder` MCP tool first") loses to
 * momentum with no trigger tied to the action, so — mirroring how snooze went
 * from advisory to a PreToolUse gate — this decides whether the gate should
 * DENY a hand-written non-trivial code Write/Edit and redirect the agent to
 * draft with `coder` first.
 *
 * It is a ONE-SHOT per Claude Code session (keyed by `session_id`): a single
 * non-polluting redirect at the first non-trivial code write, not a per-write
 * repeat. The gate only consults this when the `coder-first` guidance is active
 * ("enforced if guided"); presence of the rule file is the toggle.
 *
 * R9.17: the state remembers a SET of sessions, not one. It used to hold a
 * single id, and a project routinely has more than one session in it at a time —
 * a second window, a parallel agent, a headless `claude -p`. Each new session
 * overwrote the slot, so the previous session's one-shot was forgotten and it
 * got nudged again at its next code write, indefinitely. Measured on this repo:
 * `session_id` is stable within a session (it matches `transcript_path`), so the
 * key was never the problem — the single slot was.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** Below this many chars of new code, a write is trivial — no nudge. */
export const MIN_CODE_DRAFT_CHARS = 240;

/** Source-code extensions that count as "code" for the nudge. */
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

/** Only these tools write file content we'd want drafted. */
const CODE_WRITE_TOOLS = new Set(["Write", "Edit"]);

/** Fallback one-shot key when a payload carries no session id. */
const NO_SESSION_KEY = "__no_session__";

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function isCodeFile(filePath: string): boolean {
  if (filePath.endsWith(".d.ts")) return false; // type decls carry no logic
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Whether the pending call writes non-trivial code. Pure; narrows the unknown
 * `toolInput` safely (may be a non-object, fields may be missing/non-string).
 * `contentLength` is the size of the new code (`content` for Write, `new_string`
 * for Edit) and is returned for observability even when `isCode` is false.
 */
export function isCodeDraftTarget(
  toolName: string,
  toolInput: unknown,
): { isCode: boolean; contentLength: number } {
  if (!CODE_WRITE_TOOLS.has(toolName)) return { isCode: false, contentLength: 0 };
  const input = asRecord(toolInput);
  if (input === null) return { isCode: false, contentLength: 0 };

  const filePath = input.file_path;
  if (typeof filePath !== "string" || !isCodeFile(filePath)) {
    return { isCode: false, contentLength: 0 };
  }

  const body = toolName === "Write" ? input.content : input.new_string;
  const contentLength = typeof body === "string" ? body.length : 0;
  return { isCode: contentLength >= MIN_CODE_DRAFT_CHARS, contentLength };
}

/** Outcome of a coder-first decision. `nudge:false` → the gate stays silent. */
export interface CoderFirstNudgeDecision {
  readonly nudge: boolean;
  /** The one-shot key to persist — present only when nudging. */
  readonly sessionKey?: string;
}

/**
 * Decide whether to nudge. Pure. Nudges when the target is non-trivial code and
 * this session has NOT been nudged before (one-shot per session). A missing
 * session id still one-shots via a stable fallback key. `sessionKey` is the
 * value the caller must persist so the compared-against and stored keys never
 * diverge.
 */
export function decideCoderFirstNudge(
  target: { isCode: boolean },
  alreadyNudgedSessionIds: readonly string[],
  currentSessionId: string | undefined,
): CoderFirstNudgeDecision {
  if (!target.isCode) return { nudge: false };
  const key = currentSessionId ?? NO_SESSION_KEY;
  if (alreadyNudgedSessionIds.includes(key)) return { nudge: false }; // one-shot per session
  return { nudge: true, sessionKey: key };
}

/**
 * The instruction shown to the agent (as the PreToolUse deny reason). Pure.
 * Crucially tells an agent that already drafted with `coder` to proceed, so the
 * one denied write doesn't cause a re-draft or a loop.
 */
export function coderFirstNudgeReason(): string {
  return (
    "**Golem** This project prefers drafting non-trivial code with the local " +
    "`coder` MCP tool first, then reviewing and refining the result — it leaves " +
    "the paid model's tokens for the judgment calls (review, integration, the " +
    "genuinely hard parts). Draft this code with the `coder` tool, then retry the " +
    "write with the reviewed result. **If you already drafted this with `coder`, " +
    "say so and proceed with the write** — this is a one-shot reminder, not a " +
    "block on drafted code."
  );
}

/** `.golem/state/coder-first-nudge.json` for a project. */
export function coderFirstNudgeStatePath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "coder-first-nudge.json");
}

/**
 * `nudgedSessionIds` is the current shape; `nudgedSessionId` is the pre-R9.17
 * single slot, still read so an existing file keeps its one recorded session
 * instead of re-nudging it once on upgrade.
 */
const stateSchema = z.object({
  nudgedSessionIds: z.array(z.string()).optional(),
  nudgedSessionId: z.string().optional(),
});

/**
 * Cap on remembered sessions. Long enough that no realistic set of concurrent or
 * recent sessions evicts a live one, short enough that the file cannot grow
 * without bound in a long-lived project.
 */
export const MAX_REMEMBERED_SESSIONS = 50;

/** Sessions already nudged. Missing or corrupt state → empty (fail-open: nudge once). */
export async function readCoderFirstNudgeState(projectDir: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(coderFirstNudgeStatePath(projectDir), "utf8");
  } catch {
    return [];
  }
  try {
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = stateSchema.safeParse(JSON.parse(stripped));
    if (!parsed.success) return [];
    const { nudgedSessionIds, nudgedSessionId } = parsed.data;
    if (nudgedSessionIds !== undefined) return nudgedSessionIds;
    return nudgedSessionId === undefined ? [] : [nudgedSessionId];
  } catch {
    return [];
  }
}

/**
 * Record another nudged session (atomic temp+rename in the state dir), keeping
 * the most recent {@link MAX_REMEMBERED_SESSIONS}.
 *
 * Read-modify-write, so two sessions nudging at the same instant can lose one
 * append. That costs at most one extra nudge in one session, which is the
 * failure this whole change exists to bound — worth far less than a lock file.
 */
export async function writeCoderFirstNudgeState(
  projectDir: string,
  sessionId: string,
): Promise<void> {
  const existing = await readCoderFirstNudgeState(projectDir);
  const next = [...existing.filter((id) => id !== sessionId), sessionId].slice(
    -MAX_REMEMBERED_SESSIONS,
  );
  const file = coderFirstNudgeStatePath(projectDir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ nudgedSessionIds: next }, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}
