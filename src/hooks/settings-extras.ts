/**
 * `.claude` settings writers for the rest of the Golem wiring `golem init`
 * installs: the status line (Decision 21c) and the matcher-less event hooks
 * (Notification / UserPromptSubmit → blocked-state, Decision 21b groundwork).
 *
 * Target file: `claude.settings_scope`, exactly as in settings-writer.ts.
 *
 * Same conventions as settings-writer.ts: merge-preserving, never clobber
 * malformed files or FOREIGN settings, report InitAction, honor dryRun.
 */

import { claudeSettingsFiles, claudeSettingsTarget } from "../cli/claude-settings-target.js";
import type { InitAction } from "../cli/init.js";
// R10.1: this module used to carry its OWN readJsonObject/writeJsonObject/rel —
// a fourth copy, differing from the others only in an error message. It now
// shares the one in cli/json-file.ts, which (unlike this copy) writes
// atomically. `.claude/settings.json` is read back several times during a single
// `golem init`, so a non-atomic write left a window where a reader saw a
// truncated file and init failed against JSON it had just written itself.
import { InitError } from "../cli/init-error.js";
import { readJsonObject, rel, writeJsonObject } from "../cli/json-file.js";
import type { HookSettingsOptions } from "./settings-writer.js";

export const NOTIFICATION_COMMAND = "golem hook notification";
export const PROMPT_SUBMIT_COMMAND = "golem hook prompt-submit";
export const STATUS_LINE_COMMAND = "golem statusline";
/**
 * Seconds between timer-driven status-line refreshes (Claude Code's
 * `statusLine.refreshInterval`, verified 2026-07-24 against
 * code.claude.com/docs/en/statusline: min 1, unit seconds). Without it the line
 * only re-runs on conversation events (a new assistant message, /compact, mode
 * change), so external state changes — e.g. the slider set from the VS Code
 * extension — would not appear on an idle terminal until the next turn. A small
 * interval makes those near-live; `golem statusline` caches its slow ops (the
 * local-model probe) so the poll is cheap.
 */
export const STATUS_LINE_REFRESH_INTERVAL_SEC = 2;
/**
 * "auto" mode (Claude Code's research-preview background-safety-check
 * approval path) evaluates each tool call independently of `permissions.allow`
 * — a project's `Bash(golem:*)`/`mcp__golem` allow-rules can still re-prompt
 * under it. "default" makes allow-list matching authoritative again, so
 * golem's own allow-rules (written elsewhere in init) are actually sufficient.
 */
export const GOLEM_DEFAULT_MODE = "default";

type JsonObject = Record<string, unknown>;
const isRecord = (v: unknown): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The `.claude` settings file this call operates on — see settings-writer.ts. */
const settingsPath = (options: HookSettingsOptions): Promise<string> =>
  claudeSettingsTarget(options.projectDir, options.scope);

/** A matcher-less command-hook entry: `{ hooks: [{ type, command }] }`. */
function eventEntry(command: string): JsonObject {
  return { hooks: [{ type: "command", command }] };
}
const hookHasCommand = (hook: unknown, command: string): boolean =>
  isRecord(hook) && hook.command === command;

/** Idempotently add a matcher-less event hook (e.g. Notification) for our command. */
export async function addEventHook(
  options: HookSettingsOptions,
  event: string,
  command: string,
): Promise<InitAction> {
  const { projectDir } = options;
  const file = await settingsPath(options);
  const existing = await readJsonObject(file);
  const settings = existing ?? {};

  const hooksValue = settings.hooks;
  if (hooksValue !== undefined && !isRecord(hooksValue)) {
    throw new InitError(`${file}: "hooks" must be a JSON object`);
  }
  const hooks: JsonObject = isRecord(hooksValue) ? hooksValue : {};
  settings.hooks = hooks;

  const listValue = hooks[event];
  if (listValue !== undefined && !Array.isArray(listValue)) {
    throw new InitError(`${file}: "hooks.${event}" must be a JSON array`);
  }
  const list: unknown[] = Array.isArray(listValue) ? listValue : [];

  const present = list.some(
    (entry) =>
      isRecord(entry) &&
      Array.isArray(entry.hooks) &&
      entry.hooks.some((h) => hookHasCommand(h, command)),
  );
  if (present) {
    return { kind: "skip", path: rel(projectDir, file), detail: `${event} hook already installed` };
  }

  hooks[event] = [...list, eventEntry(command)];
  if (options.dryRun !== true) await writeJsonObject(file, settings);
  return {
    kind: existing === null ? "create" : "modify",
    path: rel(projectDir, file),
    detail: `hooks.${event} += ${command}`,
  };
}

/** Remove exactly the event hook `addEventHook` installed; preserve foreign hooks. */
export async function removeEventHook(
  options: HookSettingsOptions,
  event: string,
  command: string,
): Promise<InitAction> {
  const { projectDir } = options;
  const file = await settingsPath(options);
  const relPath = rel(projectDir, file);
  const settings = await readJsonObject(file);
  const hooks = settings?.hooks;
  const list = isRecord(hooks) ? hooks[event] : undefined;
  if (settings === null || !isRecord(hooks) || !Array.isArray(list)) {
    return { kind: "skip", path: relPath, detail: `${event} hook not installed` };
  }

  let changed = false;
  const kept: unknown[] = [];
  for (const entry of list) {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
      kept.push(entry);
      continue;
    }
    const keptHooks = entry.hooks.filter((h) => !hookHasCommand(h, command));
    if (keptHooks.length === entry.hooks.length) kept.push(entry);
    else {
      changed = true;
      if (keptHooks.length > 0) kept.push({ ...entry, hooks: keptHooks });
    }
  }
  if (!changed) return { kind: "skip", path: relPath, detail: `${event} hook not installed` };

  if (kept.length > 0) hooks[event] = kept;
  else delete hooks[event];
  if (Object.keys(hooks).length === 0) delete settings.hooks;

  if (options.dryRun !== true) await writeJsonObject(file, settings);
  return { kind: "modify", path: relPath, detail: `removed Golem ${event} hook` };
}

/** Set `statusLine` to the Golem command, unless a FOREIGN status line is set. */
export async function writeStatusLine(options: HookSettingsOptions): Promise<InitAction> {
  const { projectDir } = options;
  const { target: file, other } = await claudeSettingsFiles(options.projectDir, options.scope);
  const existing = await readJsonObject(file);
  const settings = existing ?? {};

  // A foreign status line in the OTHER file is just as much theirs as one in
  // this file — and writing ours into the higher-precedence file would take it
  // over without touching a byte of it. Same rule, one file further out.
  const otherLine = (await readJsonObject(other).catch(() => null))?.statusLine;
  if (
    isRecord(otherLine) &&
    typeof otherLine.command === "string" &&
    otherLine.command !== STATUS_LINE_COMMAND
  ) {
    return {
      kind: "skip",
      path: rel(projectDir, other),
      detail: "status line set to a non-Golem command; left as is",
    };
  }

  const current = settings.statusLine;
  const desired = {
    type: "command",
    command: STATUS_LINE_COMMAND,
    refreshInterval: STATUS_LINE_REFRESH_INTERVAL_SEC,
  };
  if (isRecord(current) && current.command === STATUS_LINE_COMMAND) {
    // Already ours. Upgrade in place if the refresh interval drifted — older
    // installs had none, so the line only updated on conversation activity and
    // missed external slider changes. Preserve any extra keys (e.g. padding).
    if (
      current.type === "command" &&
      current.refreshInterval === STATUS_LINE_REFRESH_INTERVAL_SEC
    ) {
      return { kind: "skip", path: rel(projectDir, file), detail: "status line already installed" };
    }
    settings.statusLine = { ...current, ...desired };
    if (options.dryRun !== true) await writeJsonObject(file, settings);
    return {
      kind: "modify",
      path: rel(projectDir, file),
      detail: `statusLine refreshInterval = ${STATUS_LINE_REFRESH_INTERVAL_SEC}s`,
    };
  }
  if (isRecord(current) && typeof current.command === "string") {
    // Someone else owns the status line — do not clobber.
    return {
      kind: "skip",
      path: rel(projectDir, file),
      detail: "status line set to a non-Golem command; left as is",
    };
  }

  settings.statusLine = desired;
  if (options.dryRun !== true) await writeJsonObject(file, settings);
  return {
    kind: existing === null ? "create" : "modify",
    path: rel(projectDir, file),
    detail: `statusLine = ${STATUS_LINE_COMMAND}`,
  };
}

/** Remove the status line only if it is ours. */
export async function removeStatusLine(options: HookSettingsOptions): Promise<InitAction> {
  const { projectDir } = options;
  const file = await settingsPath(options);
  const relPath = rel(projectDir, file);
  const settings = await readJsonObject(file);
  const current = settings?.statusLine;
  if (settings === null || !isRecord(current) || current.command !== STATUS_LINE_COMMAND) {
    return { kind: "skip", path: relPath, detail: "status line not ours" };
  }
  delete settings.statusLine;
  if (options.dryRun !== true) await writeJsonObject(file, settings);
  return { kind: "modify", path: relPath, detail: "removed Golem status line" };
}

/**
 * Set `defaultMode` to "default", unless a FOREIGN mode is already set. Only
 * ever touches an unset `defaultMode` — a user who has deliberately chosen
 * "auto"/"acceptEdits"/"bypassPermissions" keeps that choice.
 */
export async function writeDefaultMode(options: HookSettingsOptions): Promise<InitAction> {
  const { projectDir } = options;
  const { target: file, other } = await claudeSettingsFiles(options.projectDir, options.scope);
  const existing = await readJsonObject(file);
  const settings = existing ?? {};

  // A deliberate mode in the OTHER file is still the user's choice — writing
  // ours into the file that outranks it would end that choice silently.
  const otherMode = (await readJsonObject(other).catch(() => null))?.defaultMode;
  if (typeof otherMode === "string" && otherMode !== GOLEM_DEFAULT_MODE) {
    return {
      kind: "skip",
      path: rel(projectDir, other),
      detail: `defaultMode set to "${otherMode}"; left as is`,
    };
  }

  const current = settings.defaultMode;
  if (current === GOLEM_DEFAULT_MODE) {
    return { kind: "skip", path: rel(projectDir, file), detail: "defaultMode already set" };
  }
  if (typeof current === "string") {
    return {
      kind: "skip",
      path: rel(projectDir, file),
      detail: `defaultMode set to "${current}"; left as is`,
    };
  }

  settings.defaultMode = GOLEM_DEFAULT_MODE;
  if (options.dryRun !== true) await writeJsonObject(file, settings);
  return {
    kind: existing === null ? "create" : "modify",
    path: rel(projectDir, file),
    detail: `defaultMode = ${GOLEM_DEFAULT_MODE}`,
  };
}

/** Remove the `defaultMode` override only if it is ours. */
export async function removeDefaultMode(options: HookSettingsOptions): Promise<InitAction> {
  const { projectDir } = options;
  const file = await settingsPath(options);
  const relPath = rel(projectDir, file);
  const settings = await readJsonObject(file);
  const current = settings?.defaultMode;
  if (settings === null || current !== GOLEM_DEFAULT_MODE) {
    return { kind: "skip", path: relPath, detail: "defaultMode not ours" };
  }
  delete settings.defaultMode;
  if (options.dryRun !== true) await writeJsonObject(file, settings);
  return { kind: "modify", path: relPath, detail: "removed Golem defaultMode override" };
}
