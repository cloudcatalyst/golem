/**
 * Where the personal vibe guide lives, and the gate that decides whether it may
 * be opened at all.
 *
 * The guide is PERSONAL: one per human, under `~/.golem/vibe/`, shared by every
 * project that human works on. That is the opposite of everything else Golem
 * stores, so the gate matters more than usual — a style guide is derived from
 * the user's real source files, and it must not be readable from a directory
 * that has nothing to do with Golem.
 *
 * `~/.golem/` is resolved through `defaultUserDir()` rather than env-paths, per
 * spec Decision 19 / verification-notes §17.
 */

import os from "node:os";
import path from "node:path";
import { defaultUserDir, findProjectDir } from "../config/paths.js";

/** Subdirectory of the user dir that holds the whole guide. */
export const VIBE_DIR_NAME = "vibe";

/** The brief is the only file that is ALWAYS loaded, so it is the only one capped. */
export const BRIEF_FILE = "VIBE.md";
export const GUIDELINES_DIR = "guidelines";
export const SNIPPETS_DIR = "snippets";
export const SOURCES_FILE = "sources.json";
export const CANDIDATES_FILE = "candidates.jsonl";

/**
 * Hard ceiling on the always-loaded brief, in bytes.
 *
 * This is the whole anti-bloat contract in one number: everything else in the
 * guide is fetched on demand, so the brief is the only part that costs tokens on
 * every coding turn. ~4 KiB is roughly 1k tokens. A brief that would exceed it
 * is truncated at a section boundary rather than silently growing the prefix of
 * every request.
 */
export const BRIEF_MAX_BYTES = 4096;

/** Absolute paths of every part of the guide, for a given user dir. */
export interface VibePaths {
  readonly root: string;
  readonly brief: string;
  readonly guidelines: string;
  readonly snippets: string;
  readonly sources: string;
  readonly candidates: string;
}

/** Pure path arithmetic — no filesystem access, no gating. */
export function vibePaths(userDir: string = defaultUserDir()): VibePaths {
  const root = path.join(path.resolve(userDir), VIBE_DIR_NAME);
  return {
    root,
    brief: path.join(root, BRIEF_FILE),
    guidelines: path.join(root, GUIDELINES_DIR),
    snippets: path.join(root, SNIPPETS_DIR),
    sources: path.join(root, SOURCES_FILE),
    candidates: path.join(root, CANDIDATES_FILE),
  };
}

/**
 * THE GATE. Only a Golem-initialised project may reach the personal guide.
 *
 * Presence of the skill file is not the gate — a skill file is just markdown and
 * can be copied into any repository. This is, and it is checked before any path
 * under `~/.golem/vibe/` is opened, so a non-Golem directory performs zero reads
 * rather than reads that happen to return nothing.
 *
 * `findProjectDir` walks up looking for `.golem/settings.json`, so a
 * subdirectory of a Golem project passes, as it should.
 */
export function isGolemProject(
  dir: string,
  rootDir?: string,
  home: string = os.homedir(),
): boolean {
  const found = findProjectDir(dir, rootDir);
  if (found === null) return false;
  // The HOME DIRECTORY IS NOT A PROJECT. `~/.golem/settings.json` is the user
  // scope (Decision 19) and it sits at exactly the path the project marker is
  // looked for, so an upward walk from anywhere under the home directory finds
  // it and every directory on the machine passes. That is most of the disk on a
  // developer laptop, and it would make the gate decorative.
  return path.resolve(found) !== path.resolve(home);
}
