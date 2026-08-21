/**
 * Decision 21b / R12.2 — Golem session state: the documented **blocked read
 * model**.
 *
 * A small JSON file under `<project>/.golem/state/session.json` records whether
 * the Claude Code session is waiting on the human, and — since R12.2 — *what it
 * is waiting on*. This is the one shared state that every renderer reads: the
 * `golem statusline` indicator, the VS Code status bar and panel, the loopback
 * dashboard's `/api/state`, and (ADR-0006 capability 1) a paired device. One
 * source, many renderers.
 *
 * ## Why it had to be widened
 *
 * Before R12.2 the model was `{ blocked, reason?, sessionId?, ts }`, where
 * `reason` was whatever string the Notification hook happened to receive. That
 * is enough for a dot on a status line. It is not enough for a human 20 minutes
 * away deciding whether to approve something: *"waiting on your input" is not an
 * approvable question.* Worse, Claude Code's `Notification` payload carries a
 * **generic** message — verified 2026-08-21 against
 * https://code.claude.com/docs/en/hooks#notification, whose own example is
 * `"message": "Claude needs your permission"` with no tool name anywhere in it.
 * The message alone therefore *cannot* answer "blocked on what", which is why
 * {@link PendingToolCall} exists (below).
 *
 * ## Redaction is unconditional here
 *
 * This file is the first Golem-written artefact whose *purpose* is to carry a
 * verbatim tool argument, and ADR-0006 §1 makes it a remote payload: "everything
 * in it is redacted before it is written … Same rule as everything else, no new
 * exception." So {@link writeSessionState} runs **every string in the record**
 * through the redaction stage (`src/pipeline/redaction.ts`) before it touches the
 * disk, there is no option to turn that off, and if the redactor cannot be loaded
 * the write is **abandoned rather than performed** (fail closed — a status
 * indicator is never worth leaking a credential).
 *
 * A consequence worth stating: the sweep applies to the project path too, so a
 * high-entropy directory segment can land as a placeholder. That is the correct
 * trade — the alternative is an exception to the redaction rule, and there isn't
 * one.
 *
 * ## Nothing here opens a network surface
 *
 * No listener, no binding, no write-from-outside path. Serving this to a device
 * is ADR-0006's guarded step (R12.3/R12.4); this module only widens what a local
 * reader can see. All writes stay best-effort and never throw into a hook.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "../shared/json.js";

/**
 * What the session is actually blocked on. These are different decisions and
 * before R12.2 they collapsed into one boolean.
 *
 * Mapped from Claude Code's `notification_type` where possible (verified
 * 2026-08-21): `permission_prompt` → `permission`, `idle_prompt` → `idle`,
 * everything that wants an answer (`agent_needs_input`, the `elicitation_*`
 * dialogs) → `question`.
 */
export type BlockKind = "permission" | "question" | "idle";

/**
 * For a permission request: the tool and the single argument the human must
 * judge — a `Bash` command, a file path, a URL. This is the whole point of the
 * widening, and the reason redaction above is not optional.
 */
export interface BlockedTool {
  /** Tool name as Claude Code reported it (`Bash`, `Edit`, `WebFetch`, …). */
  readonly name: string;
  /** The argument to judge, REDACTED. Absent when it could not be determined. */
  readonly argument?: string;
  /**
   * ADR-0002's `classifyAction` class (`read`/`write`/`unknown`/`destructive`/
   * `outward`). Carried because ADR-0006 §2 makes it the field that decides
   * whether a remote device may answer at all — `destructive` and `outward`
   * wait for the laptop. R12.2 only records it; nothing here approves anything.
   */
  readonly actionClass?: string;
}

/** Which working tree this is — a `sessionId` does not name a project. */
export interface BlockedProject {
  readonly dir: string;
  /** Basename of the directory: what a phone-sized surface can actually show. */
  readonly name: string;
}

/**
 * Why the file last changed. Lets a reader tell a deliberate clear from a block
 * that was simply never resolved — see {@link resolveBlock}.
 */
export type SessionEvent = "blocked" | "responded";

/** The read model. `v` is the shape version, so a reader can refuse what it does not know. */
export interface SessionState {
  /** Read-model version. R12.2 is 2; a v1 file (no `v`) is upgraded on read. */
  readonly v: 2;
  readonly blocked: boolean;
  /** ISO-8601 timestamp of the last state change — the "since when". */
  readonly ts: string;
  /** Human-readable reason (the notification text), redacted, when blocked. */
  readonly reason?: string;
  readonly sessionId?: string;
  readonly project?: BlockedProject;
  readonly kind?: BlockKind;
  readonly tool?: BlockedTool;
  readonly lastEvent?: SessionEvent;
}

/** State file location for a project. */
export function sessionStatePath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "session.json");
}

/** Where the pending-tool-call record lives (see {@link PendingToolCall}). */
export function pendingToolPath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "pending-tool.json");
}

/**
 * A tool call that is about to face the human, recorded by the PreToolUse hook.
 *
 * Necessary because Claude Code's `Notification` payload names no tool (see the
 * module doc): `permission_prompt` fires roughly six seconds *after* the prompt
 * appears, by which time PreToolUse has already seen the real `tool_name` and
 * `tool_input`. The Notification handler correlates the two and copies the
 * result into {@link SessionState.tool}.
 *
 * Written already redacted, on the same terms as the state file itself.
 */
export interface PendingToolCall {
  readonly name: string;
  readonly argument?: string;
  readonly actionClass?: string;
  readonly sessionId?: string;
  readonly ts: string;
}

/**
 * How long a pending record may be correlated with a notification. Generous
 * relative to the documented ~6s permission-prompt delay, but far short of
 * {@link BLOCKED_STALE_MS}: past this the pending call is more likely to be a
 * previous, already-answered one.
 */
export const PENDING_TOOL_MAX_AGE_MS = 2 * 60_000;

/**
 * A blocked flag older than this is treated as stale — the local "waiting"
 * indicator clears itself rather than sticking on forever if the clearing hook
 * never fired. Moved here from `src/cli/statusline.ts` in R12.2: the staleness
 * rule belongs to the read model, not to one of its renderers.
 */
export const BLOCKED_STALE_MS = 10 * 60_000;

/** Is a blocked-state timestamp recent enough to still mean "waiting"? */
export function isBlockedFresh(ts: string, nowMs: number = Date.now()): boolean {
  const t = Date.parse(ts);
  return Number.isFinite(t) && nowMs - t >= 0 && nowMs - t < BLOCKED_STALE_MS;
}

/**
 * The four answers a reader can get, kept distinct on purpose.
 *
 * - `waiting` — blocked, and the flag is fresh. Someone is being asked something.
 * - `abandoned` — blocked, but stale: **nobody ever wrote again.** The session
 *   died mid-prompt, was cleared, or moved on without the UserPromptSubmit hook
 *   firing. This is the case the old model could not express, because a stale
 *   `blocked: true` was simply hidden and read as if nothing were happening.
 * - `clear` — a writer explicitly said the human responded (`lastEvent`).
 * - `unknown` — no file, or an unreadable one. Not the same as `clear`.
 */
export type BlockStatus = "waiting" | "abandoned" | "clear" | "unknown";

export interface ResolvedBlock {
  readonly status: BlockStatus;
  readonly state: SessionState | null;
  /** Age of `state.ts` in ms; absent when there is no parseable timestamp. */
  readonly ageMs?: number;
}

/**
 * Classify a read state. Pure, so every renderer resolves the same way instead
 * of each re-deriving staleness — which is how the dashboard and the status line
 * came to disagree about a stale block in the first place.
 */
export function resolveBlock(
  state: SessionState | null,
  nowMs: number = Date.now(),
): ResolvedBlock {
  if (state === null) return { status: "unknown", state: null };
  const t = Date.parse(state.ts);
  const age = Number.isFinite(t) ? { ageMs: nowMs - t } : {};
  if (!state.blocked) return { status: "clear", state, ...age };
  return {
    status: isBlockedFresh(state.ts, nowMs) ? "waiting" : "abandoned",
    state,
    ...age,
  };
}

// --- reading ------------------------------------------------------------------

function readProject(value: unknown): BlockedProject | undefined {
  if (!isRecord(value)) return undefined;
  const { dir, name } = value;
  if (typeof dir !== "string" || typeof name !== "string") return undefined;
  return { dir, name };
}

function readTool(value: unknown): BlockedTool | undefined {
  if (!isRecord(value)) return undefined;
  const { name, argument, actionClass } = value;
  if (typeof name !== "string" || name === "") return undefined;
  return {
    name,
    ...(typeof argument === "string" ? { argument } : {}),
    ...(typeof actionClass === "string" ? { actionClass } : {}),
  };
}

function readKind(value: unknown): BlockKind | undefined {
  return value === "permission" || value === "question" || value === "idle" ? value : undefined;
}

function readEvent(value: unknown): SessionEvent | undefined {
  return value === "blocked" || value === "responded" ? value : undefined;
}

/**
 * Read the session state, or null if none/unreadable. Never throws.
 *
 * Accepts a **v1** file (no `v`, only `blocked`/`ts`/`reason`/`sessionId`) and
 * normalises it to v2 with the new fields absent, so a project last written by
 * an older Golem — or one caught mid-upgrade — degrades to the old, merely
 * incomplete display rather than to nothing at all.
 */
export async function readSessionState(projectDir: string): Promise<SessionState | null> {
  try {
    const raw = await readFile(sessionStatePath(projectDir), "utf8");
    const j: unknown = JSON.parse(raw);
    if (!isRecord(j)) return null;
    if (typeof j.blocked !== "boolean" || typeof j.ts !== "string") return null;
    const project = readProject(j.project);
    const tool = readTool(j.tool);
    const kind = readKind(j.kind);
    const lastEvent = readEvent(j.lastEvent);
    return {
      v: 2,
      blocked: j.blocked,
      ts: j.ts,
      ...(typeof j.reason === "string" ? { reason: j.reason } : {}),
      ...(typeof j.sessionId === "string" ? { sessionId: j.sessionId } : {}),
      ...(project !== undefined ? { project } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(tool !== undefined ? { tool } : {}),
      ...(lastEvent !== undefined ? { lastEvent } : {}),
    };
  } catch {
    return null;
  }
}

/** Read the pending tool call, or null if none/unreadable. Never throws. */
export async function readPendingToolCall(projectDir: string): Promise<PendingToolCall | null> {
  try {
    const raw = await readFile(pendingToolPath(projectDir), "utf8");
    const j: unknown = JSON.parse(raw);
    if (!isRecord(j)) return null;
    if (typeof j.name !== "string" || j.name === "" || typeof j.ts !== "string") return null;
    return {
      name: j.name,
      ts: j.ts,
      ...(typeof j.argument === "string" ? { argument: j.argument } : {}),
      ...(typeof j.actionClass === "string" ? { actionClass: j.actionClass } : {}),
      ...(typeof j.sessionId === "string" ? { sessionId: j.sessionId } : {}),
    };
  } catch {
    return null;
  }
}

// --- redaction + writing ------------------------------------------------------

/**
 * Redact every string in a JSON-shaped value.
 *
 * Recursive by design: a field added to the read model later is covered without
 * anyone remembering to redact it, which is the property a hand-written
 * field-by-field pass does not have. Applied to raw values rather than to the
 * serialized JSON, so a secret containing a quote is still matched (in JSON text
 * it would appear escaped).
 */
function redactDeep<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === "string") return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact)) as unknown as T;
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, redact);
    return out as unknown as T;
  }
  return value;
}

/**
 * Load the redaction stage.
 *
 * Imported lazily on purpose. `session-state.ts` is on the per-prompt status-line
 * read path, and `../pipeline/redaction.js` reaches the compression barrel; the
 * READ path must not pay for it. Only writers do.
 */
async function loadRedactor(): Promise<(text: string) => string> {
  const { redactStandaloneText } = await import("../pipeline/redaction.js");
  return redactStandaloneText;
}

/**
 * Write the state atomically (temp + rename), redacting first. Best-effort;
 * never throws.
 *
 * **Fail closed.** If the redaction stage cannot be loaded, nothing is written.
 * There is no unredacted fallback and no flag that produces one: per CLAUDE.md,
 * redaction is never weakened, and the whole point of R12.2 is that this file may
 * carry a verbatim tool argument.
 */
export async function writeSessionState(projectDir: string, state: SessionState): Promise<void> {
  try {
    const redact = await loadRedactor();
    await writeAtomic(sessionStatePath(projectDir), redactDeep(state, redact));
  } catch {
    // best-effort — a status indicator is not worth failing a hook over
  }
}

/** Record the tool call about to face the human. Redacted, atomic, never throws. */
export async function writePendingToolCall(
  projectDir: string,
  call: PendingToolCall,
): Promise<void> {
  try {
    const redact = await loadRedactor();
    await writeAtomic(pendingToolPath(projectDir), redactDeep(call, redact));
  } catch {
    // best-effort
  }
}

async function writeAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

/** Everything a block carries beyond "blocked, at this time, in this session". */
export interface BlockDetails {
  readonly kind?: BlockKind;
  readonly tool?: BlockedTool;
  /** Defaults to the project dir and its basename. */
  readonly project?: BlockedProject;
}

/** The project identity for `dir`, as written into the read model. */
export function projectIdentity(dir: string): BlockedProject {
  return { dir, name: path.basename(dir) };
}

/** Mark the session blocked on the human. */
export function markBlocked(
  projectDir: string,
  reason: string,
  nowIso: string,
  sessionId?: string,
  details: BlockDetails = {},
): Promise<void> {
  return writeSessionState(projectDir, {
    v: 2,
    blocked: true,
    reason,
    ts: nowIso,
    lastEvent: "blocked",
    project: details.project ?? projectIdentity(projectDir),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(details.kind !== undefined ? { kind: details.kind } : {}),
    ...(details.tool !== undefined ? { tool: details.tool } : {}),
  });
}

/**
 * Clear the blocked flag: the human responded, or a tool ran.
 *
 * `lastEvent: "responded"` is the load-bearing part — it is what lets a reader
 * tell this from a block nobody ever came back to (see {@link resolveBlock}).
 */
export function markUnblocked(
  projectDir: string,
  nowIso: string,
  sessionId?: string,
): Promise<void> {
  return writeSessionState(projectDir, {
    v: 2,
    blocked: false,
    ts: nowIso,
    lastEvent: "responded",
    project: projectIdentity(projectDir),
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}
