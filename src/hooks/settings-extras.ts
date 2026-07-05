/**
 * `.claude/settings.json` writers for the rest of the Golem wiring `golem init`
 * installs: the status line (Decision 21c) and the matcher-less event hooks
 * (Notification / UserPromptSubmit → blocked-state, Decision 21b groundwork).
 *
 * Same conventions as settings-writer.ts: merge-preserving, never clobber
 * malformed files or FOREIGN settings, report InitAction, honor dryRun.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type InitAction, InitError } from "../cli/init.js";
import type { HookSettingsOptions } from "./settings-writer.js";

export const NOTIFICATION_COMMAND = "golem hook notification";
export const PROMPT_SUBMIT_COMMAND = "golem hook prompt-submit";
export const STATUS_LINE_COMMAND = "golem statusline";

type JsonObject = Record<string, unknown>;
const isRecord = (v: unknown): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

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
  if (!isRecord(parsed)) throw new InitError(`${file} must contain a JSON object`);
  return parsed;
}

async function writeJsonObject(file: string, value: JsonObject): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const rel = (projectDir: string, abs: string): string =>
  path.relative(projectDir, abs).split(path.sep).join("/");
const settingsPath = (projectDir: string): string =>
  path.join(projectDir, ".claude", "settings.json");

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
  const file = settingsPath(projectDir);
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
  const file = settingsPath(projectDir);
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
  const file = settingsPath(projectDir);
  const existing = await readJsonObject(file);
  const settings = existing ?? {};

  const current = settings.statusLine;
  if (isRecord(current) && current.command === STATUS_LINE_COMMAND) {
    return { kind: "skip", path: rel(projectDir, file), detail: "status line already installed" };
  }
  if (isRecord(current) && typeof current.command === "string") {
    // Someone else owns the status line — do not clobber.
    return {
      kind: "skip",
      path: rel(projectDir, file),
      detail: "status line set to a non-Golem command; left as is",
    };
  }

  settings.statusLine = { type: "command", command: STATUS_LINE_COMMAND };
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
  const file = settingsPath(projectDir);
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
