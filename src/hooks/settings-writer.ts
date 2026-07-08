/**
 * `.claude/settings.json` writer for the Golem PostToolUse hook entry
 * (WS-B task B2). Called by the E2 init/uninit flows (wired by the
 * integrator — src/hooks/ never edits src/cli/).
 *
 * Hook config schema re-verified 2026-07-04 (verification-notes §20):
 *   {"hooks": {"PostToolUse": [{"matcher": "...",
 *       "hooks": [{"type": "command", "command": "...", "timeout": <seconds>,
 *                  "async": false}]}]}}
 *
 * Conventions follow src/cli/init.ts: merge-preserving JSON read/write,
 * never clobber malformed files (InitError instead), report InitAction
 * objects, `dryRun` computes without writing. Foreign hooks — other
 * PostToolUse entries, or foreign commands sharing a matcher entry with ours —
 * are always preserved byte-for-byte; ours are identified by their `command`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type InitAction, InitError } from "../cli/init.js";

/**
 * Tools whose outputs get big enough to be worth swapping (task brief):
 * command output, file reads, searches, and web fetches.
 */
export const POST_TOOL_USE_MATCHER = "Bash|Read|Grep|Glob|WebFetch";

/** The command Claude Code runs; requires `golem` on PATH (like `.mcp.json`). */
export const POST_TOOL_USE_COMMAND = "golem hook post-tool-use";

/**
 * Seconds (verified unit — notes §20). The hook only hashes + writes one
 * local blob, so normally < 100 ms; 30 s covers a cold Node start plus a slow
 * disk without ever hanging a session for the default 600 s.
 */
export const POST_TOOL_USE_TIMEOUT_SECONDS = 30;

/**
 * The hook must complete BEFORE the output enters model context, so it can
 * never be async (async hooks don't block; the unswapped output would ship).
 */
const POST_TOOL_USE_ASYNC = false;

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a JSON object file; missing -> null; malformed -> InitError (init.ts convention). */
async function readJsonObject(file: string): Promise<JsonObject | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InitError(`${file} is not valid JSON — fix or remove it, then retry`);
  }
  if (!isRecord(parsed)) {
    throw new InitError(`${file} must contain a JSON object`);
  }
  return parsed;
}

async function writeJsonObject(file: string, value: JsonObject): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function rel(projectDir: string, abs: string): string {
  return path.relative(projectDir, abs).split(path.sep).join("/");
}

function settingsPath(projectDir: string): string {
  return path.join(projectDir, ".claude", "settings.json");
}

/** The exact PostToolUse entry `addPostToolUseHook` installs. */
export function golemPostToolUseEntry(): JsonObject {
  return {
    matcher: POST_TOOL_USE_MATCHER,
    hooks: [
      {
        type: "command",
        command: POST_TOOL_USE_COMMAND,
        async: POST_TOOL_USE_ASYNC,
        timeout: POST_TOOL_USE_TIMEOUT_SECONDS,
      },
    ],
  };
}

/** Is this hook object ours? Identified by its command string. */
function isGolemHook(hook: unknown): boolean {
  return isRecord(hook) && hook.command === POST_TOOL_USE_COMMAND;
}

/** WebFetch KB-cache hooks (verification-notes §44). */
export const WEB_FETCH_PRE_COMMAND = "golem hook web-fetch-pre";
export const WEB_FETCH_POST_COMMAND = "golem hook web-fetch-post";
export const WEB_FETCH_MATCHER = "WebFetch";

/** SessionStart hook: auto-start the proxy on project open if it was running (§47). */
export const SESSION_START_COMMAND = "golem hook session-start";
/** Fire on a new session and on resume (project (re)open). */
export const SESSION_START_MATCHER = "startup|resume";

/**
 * Remove Golem hook objects from a PostToolUse entry list, preserving foreign
 * entries and foreign hooks that share an entry with ours. Entries emptied by
 * the removal are dropped. Returns null when nothing changed.
 */
function stripGolemHooks(list: readonly unknown[]): unknown[] | null {
  let changed = false;
  const out: unknown[] = [];
  for (const entry of list) {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
      out.push(entry); // not the documented shape — foreign, keep untouched
      continue;
    }
    const hooks = entry.hooks;
    const kept = hooks.filter((hook) => !isGolemHook(hook));
    if (kept.length === hooks.length) {
      out.push(entry);
      continue;
    }
    changed = true;
    if (kept.length > 0) {
      out.push({ ...entry, hooks: kept });
    }
  }
  return changed ? out : null;
}

export interface HookSettingsOptions {
  readonly projectDir: string;
  /** Compute and report the action without writing anything. */
  readonly dryRun?: boolean;
}

/**
 * Idempotently add the Golem PostToolUse hook entry to
 * `.claude/settings.json`. A stale Golem entry (old matcher/timeout) is
 * replaced; everything foreign is preserved.
 */
export async function addPostToolUseHook(options: HookSettingsOptions): Promise<InitAction> {
  const { projectDir } = options;
  const file = settingsPath(projectDir);
  const existing = await readJsonObject(file);
  const settings = existing ?? {};

  const hooksValue = settings.hooks;
  if (hooksValue !== undefined && !isRecord(hooksValue)) {
    throw new InitError(`${file}: "hooks" must be a JSON object`);
  }
  const hooks: JsonObject = isRecord(hooksValue) ? hooksValue : {};
  settings.hooks = hooks;

  const listValue = hooks.PostToolUse;
  if (listValue !== undefined && !Array.isArray(listValue)) {
    throw new InitError(`${file}: "hooks.PostToolUse" must be a JSON array`);
  }
  const list: unknown[] = Array.isArray(listValue) ? listValue : [];

  const desired = golemPostToolUseEntry();
  const desiredJson = JSON.stringify(desired);
  if (list.some((entry) => JSON.stringify(entry) === desiredJson)) {
    return { kind: "skip", path: rel(projectDir, file), detail: "hook already installed" };
  }

  // Replace any stale Golem hook (identified by command), then append fresh.
  const next = stripGolemHooks(list) ?? [...list];
  next.push(desired);
  hooks.PostToolUse = next;

  if (options.dryRun !== true) await writeJsonObject(file, settings);
  return {
    kind: existing === null ? "create" : "modify",
    path: rel(projectDir, file),
    detail: `hooks.PostToolUse += ${POST_TOOL_USE_COMMAND} (matcher ${POST_TOOL_USE_MATCHER})`,
  };
}

/**
 * Remove exactly the hook objects `addPostToolUseHook` installed (matched by
 * command). Empty containers left behind by the removal are pruned; foreign
 * hooks are untouched.
 */
export async function removePostToolUseHook(options: HookSettingsOptions): Promise<InitAction> {
  const { projectDir } = options;
  const file = settingsPath(projectDir);
  const relPath = rel(projectDir, file);
  const settings = await readJsonObject(file);
  const hooks = settings?.hooks;
  const list = isRecord(hooks) ? hooks.PostToolUse : undefined;
  if (settings === null || !isRecord(hooks) || !Array.isArray(list)) {
    return { kind: "skip", path: relPath, detail: "hook not installed" };
  }

  const stripped = stripGolemHooks(list);
  if (stripped === null) {
    return { kind: "skip", path: relPath, detail: "hook not installed" };
  }

  if (stripped.length > 0) {
    hooks.PostToolUse = stripped;
  } else {
    delete hooks.PostToolUse;
  }
  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  }

  if (options.dryRun !== true) await writeJsonObject(file, settings);
  return { kind: "modify", path: relPath, detail: "removed Golem PostToolUse hook" };
}

/** A generic matcher'd hook to install (event + matcher + our command). */
export interface MatcherHookSpec {
  /** "PreToolUse" | "PostToolUse" | … */
  readonly event: string;
  readonly matcher: string;
  readonly command: string;
  readonly timeoutSeconds?: number;
  /** async:true = non-blocking (capture); false = blocking (the pre-fetch gate). */
  readonly async?: boolean;
}

function matcherEntry(spec: MatcherHookSpec): JsonObject {
  const hook: JsonObject = { type: "command", command: spec.command };
  if (spec.async !== undefined) hook.async = spec.async;
  if (spec.timeoutSeconds !== undefined) hook.timeout = spec.timeoutSeconds;
  return { matcher: spec.matcher, hooks: [hook] };
}

function stripByCommand(list: readonly unknown[], command: string): unknown[] | null {
  let changed = false;
  const out: unknown[] = [];
  for (const entry of list) {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
      out.push(entry);
      continue;
    }
    const kept = entry.hooks.filter((h) => !(isRecord(h) && h.command === command));
    if (kept.length === entry.hooks.length) {
      out.push(entry);
      continue;
    }
    changed = true;
    if (kept.length > 0) out.push({ ...entry, hooks: kept });
  }
  return changed ? out : null;
}

/** Idempotently add a matcher'd hook (any event) for our command; stale copies replaced. */
export async function addMatcherHook(
  options: HookSettingsOptions,
  spec: MatcherHookSpec,
): Promise<InitAction> {
  const { projectDir } = options;
  const file = settingsPath(projectDir);
  const existing = await readJsonObject(file);
  const settings = existing ?? {};

  const hooksValue = settings.hooks;
  if (hooksValue !== undefined && !isRecord(hooksValue)) {
    throw new InitError(`${file}: "hooks" must be a JSON object`);
  }
  const hooks: JsonObject = isRecord(hooksValue) ? hooksValue : {};
  settings.hooks = hooks;

  const listValue = hooks[spec.event];
  if (listValue !== undefined && !Array.isArray(listValue)) {
    throw new InitError(`${file}: "hooks.${spec.event}" must be a JSON array`);
  }
  const list: unknown[] = Array.isArray(listValue) ? listValue : [];

  const desired = matcherEntry(spec);
  if (list.some((e) => JSON.stringify(e) === JSON.stringify(desired))) {
    return {
      kind: "skip",
      path: rel(projectDir, file),
      detail: `${spec.command} already installed`,
    };
  }
  const next = stripByCommand(list, spec.command) ?? [...list];
  next.push(desired);
  hooks[spec.event] = next;

  if (options.dryRun !== true) await writeJsonObject(file, settings);
  return {
    kind: existing === null ? "create" : "modify",
    path: rel(projectDir, file),
    detail: `hooks.${spec.event} += ${spec.command} (matcher ${spec.matcher})`,
  };
}

/** Remove the matcher'd hook(s) for `command` under `event`; prunes emptied containers. */
export async function removeMatcherHook(
  options: HookSettingsOptions,
  event: string,
  command: string,
): Promise<InitAction> {
  const { projectDir } = options;
  const file = settingsPath(projectDir);
  const relPath = rel(projectDir, file);
  const settings = await readJsonObject(file);
  const hooks = settings?.hooks;
  const list = isRecord(hooks) ? hooks[event] : undefined;
  if (settings === null || !isRecord(hooks) || !Array.isArray(list)) {
    return { kind: "skip", path: relPath, detail: `${command} not installed` };
  }
  const stripped = stripByCommand(list, command);
  if (stripped === null) {
    return { kind: "skip", path: relPath, detail: `${command} not installed` };
  }
  if (stripped.length > 0) hooks[event] = stripped;
  else delete hooks[event];
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  if (options.dryRun !== true) await writeJsonObject(file, settings);
  return { kind: "modify", path: relPath, detail: `removed ${command}` };
}
