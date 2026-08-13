/**
 * Reading and rewriting the small JSON files Golem wires — `.claude/settings.json`,
 * `.mcp.json`, `.vscode/settings.json`, `.golem/settings*.json`.
 *
 * Three modules had grown their own copy of this: `init.ts`, `proxy-wiring.ts`
 * and `wiki.ts`. They were not the same, and the difference was not cosmetic —
 * they disagreed about what a MALFORMED file means:
 *
 * - `init.ts` threw, so `golem init` stopped and told you to fix the file.
 * - `proxy-wiring.ts` returned null, so `golem proxy wire` and `golem status`
 *   silently reported "nothing wired" for a file that was actually corrupt.
 *
 * Both behaviours are wanted, so both are kept — as two functions whose names
 * say which you are getting. That is the point of this module: a caller now
 * CHOOSES loud or quiet, instead of inheriting whichever copy it happened to
 * call. Consolidating to one behaviour would have silently changed a command.
 *
 * Rule of thumb, and how the callers are wired today: a command that WRITES a
 * file should refuse to clobber what it cannot parse ({@link readJsonObject}),
 * while a surface that merely REPORTS should degrade rather than throw at a
 * user who only asked for status ({@link readJsonObjectOrNull}).
 */

import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { InitError } from "./init-error.js";

export type JsonObject = Record<string, unknown>;

/** Does a path exist? Never throws. */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** A project-relative path with forward slashes, for stable display on Windows. */
export function rel(projectDir: string, abs: string): string {
  return path.relative(projectDir, abs).split(path.sep).join("/");
}

function asJsonObject(parsed: unknown): JsonObject | null {
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as JsonObject)
    : null;
}

/**
 * Read a JSON object file. Missing → null. Malformed, or a non-object root →
 * {@link InitError}.
 *
 * The throw is the feature: this is what a writer calls, and overwriting a file
 * we could not parse would destroy whatever the user actually had in it.
 */
export async function readJsonObject(file: string): Promise<JsonObject | null> {
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
    throw new InitError(`${file} is not valid JSON — fix or remove it, then re-run golem init`);
  }
  const obj = asJsonObject(parsed);
  if (obj === null) throw new InitError(`${file} must contain a JSON object`);
  return obj;
}

/**
 * Read a JSON object file, treating EVERY failure — missing, unreadable,
 * malformed, non-object root — as "no usable file". Never throws.
 *
 * For read-only surfaces that must not fail a user who merely asked for status.
 * Prefer {@link readJsonObject} anywhere the result decides a write.
 */
export async function readJsonObjectOrNull(file: string): Promise<JsonObject | null> {
  try {
    return asJsonObject(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return null;
  }
}

/**
 * Write a JSON object, creating the parent directory, with a trailing newline.
 *
 * The write goes to a sibling temp file and is then renamed over the target,
 * which replaces atomically (on Windows too). A plain `writeFile` leaves a
 * window in which the file exists but holds a prefix of the new content — and
 * `.claude/settings.json` is read back several times DURING a single
 * `golem init`, so a reader landing in that window sees truncated JSON and
 * init dies with "not valid JSON" against a file it wrote itself. The same
 * window is what would corrupt a user's settings if the process died mid-write.
 *
 * `src/config/file-io.ts` reached this conclusion for `.golem/settings*.json`
 * already; this is the `.claude/`-side equivalent. The two are separate on
 * purpose — this one deals in `InitAction` reporting and the config one in
 * `ConfigError` — but they must not disagree about durability.
 */
export async function writeJsonObject(file: string, value: JsonObject): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * The object at `obj[key]`, creating (and attaching) an empty one when absent or
 * not an object. Returns a live reference, so callers mutate it in place.
 */
export function objectEntry(obj: JsonObject, key: string): JsonObject {
  const existing = obj[key];
  if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
    return existing as JsonObject;
  }
  const fresh: JsonObject = {};
  obj[key] = fresh;
  return fresh;
}

/** Like {@link objectEntry} but for a string[] value (permission allow/ask lists). */
export function stringArrayEntry(obj: JsonObject, key: string): string[] {
  const existing = obj[key];
  if (Array.isArray(existing)) return existing as string[];
  const fresh: string[] = [];
  obj[key] = fresh;
  return fresh;
}
