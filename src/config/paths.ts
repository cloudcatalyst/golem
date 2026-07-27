/**
 * Settings file locations (E1). Cross-platform: node:path + node:os only.
 *
 * Spec §5.1 / Decision 19 pin the user scope to the literal `~/.golem/`
 * directory (mirroring Claude Code's `~/.claude/`), so the user dir is
 * resolved via os.homedir() rather than env-paths platform config dirs —
 * recorded in docs/plan/verification-notes.md §17. env-paths remains the tool for
 * cache/data/log dirs elsewhere in WS-E.
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const USER_DIR_NAME = ".golem";
export const PROJECT_DIR_NAME = ".golem";
export const SETTINGS_FILE = "settings.json";
export const LOCAL_SETTINGS_FILE = "settings.local.json";

/** `~/.golem` for the current platform user. */
export function defaultUserDir(): string {
  return path.join(os.homedir(), USER_DIR_NAME);
}

/** Resolved absolute paths of the three settings files. */
export interface SettingsFilePaths {
  /** `<userDir>/settings.json` (user scope, lowest file layer). */
  readonly user: string;
  /** `<project>/.golem/settings.json` (project scope, committable). */
  readonly project: string;
  /** `<project>/.golem/settings.local.json` (personal overrides, gitignored). */
  readonly local: string;
}

/**
 * Walk up from `startDir` looking for a `.golem/settings.json` marker.
 * Returns the directory that contains the `.golem/` folder, or `null` when no
 * ancestor is a Golem project. Sync and bounded (stops at the filesystem root).
 */
export function findProjectDir(startDir: string = process.cwd()): string | null {
  let dir = path.resolve(startDir);
  while (true) {
    if (existsSync(path.join(dir, PROJECT_DIR_NAME, SETTINGS_FILE))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function settingsFilePaths(opts: {
  readonly projectDir?: string;
  readonly userDir?: string;
}): SettingsFilePaths {
  const projectDir = path.resolve(opts.projectDir ?? process.cwd());
  const userDir = path.resolve(opts.userDir ?? defaultUserDir());
  return {
    user: path.join(userDir, SETTINGS_FILE),
    project: path.join(projectDir, PROJECT_DIR_NAME, SETTINGS_FILE),
    local: path.join(projectDir, PROJECT_DIR_NAME, LOCAL_SETTINGS_FILE),
  };
}
