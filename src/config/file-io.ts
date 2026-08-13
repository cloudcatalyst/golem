/**
 * Shared plumbing for the three modules that read and rewrite settings files —
 * `loader.ts`, `migrate-files.ts` and `write-setting.ts`.
 *
 * Each had grown its own copy of the same dotted-path split, the same
 * object guard, and the same temp-file-then-rename write. The write is the one
 * that mattered: three hand-copied versions of a crash-safety primitive is three
 * chances to lose a user's settings file to a half-written temp.
 */

import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// The same predicate `shared/json.ts` exports as `isRecord`. The config layer has
// always called it `isPlainObject`, so it is re-exported under that name rather
// than renaming three modules' call sites for no behavioural gain.
export { isRecord as isPlainObject } from "../shared/json.js";

/** Split a dotted `section.key`; the key is undefined when there is no dot. */
export function splitDotted(dotted: string): readonly [string, string | undefined] {
  const i = dotted.indexOf(".");
  if (i === -1) return [dotted, undefined];
  return [dotted.slice(0, i), dotted.slice(i + 1)];
}

/**
 * Replace `file` with `text` via a sibling temp file and a rename (which
 * replaces atomically on Windows too), so a crash mid-write leaves the original
 * intact rather than a truncated settings file.
 *
 * The temp file is removed on failure and the original error is rethrown
 * **unwrapped** — callers classify it, and they do not agree: `writeSetting`
 * turns it into a `ConfigError`, `deleteRetiredKey` swallows it entirely.
 *
 * Does NOT create the parent directory; see {@link writeAtomic}. The split is
 * deliberate: callers that mkdir do so *outside* their try/catch, so a mkdir
 * failure surfaces as itself and not as a write failure.
 */
export async function replaceViaTemp(file: string, text: string): Promise<void> {
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** {@link replaceViaTemp}, creating the parent directory first. */
export async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await replaceViaTemp(file, text);
}
