/**
 * WHICH Claude Code settings file Golem owns — `.claude/settings.local.json`
 * (default) or the committed `.claude/settings.json`.
 *
 * Everything `golem init` writes into Claude Code's own settings — the `env`
 * block, the `mcp__golem__*` permission rule, every hook, the status line, the
 * default permission mode — lands in ONE file, chosen by `claude.settings_scope`.
 *
 * **Why local is the default.** All of it is machine-local in practice: the base
 * URL names a per-project port assigned on THIS machine, the CA path is
 * machine-absolute (R9.22 already moved that key here), and the hooks only work
 * where `golem` is on PATH. Committed, that wiring travels to clones that cannot
 * honour it and shows up in everyone's diff whenever a port or a timeout changes.
 * `settings.local.json` also sits ABOVE `settings.json` in Claude Code's
 * precedence ladder (managed → CLI args → `settings.local.json` → `settings.json`
 * → `~/.claude/settings.json`, verification-notes §13), so nothing about how the
 * values are READ changes — only who receives them. Set
 * `claude.settings_scope=project` to go back to the committed file (a team that
 * wants the wiring in version control, with `golem` on everyone's PATH).
 *
 * **Writers resolve the scope; readers read both.** A reader that only consults
 * the configured scope would go blind the moment someone flips the key, so
 * {@link claudeSettingsReadOrder} hands back both files in Claude Code's own
 * precedence order (local first) and every read walks that list. Only the WRITE
 * target is a choice.
 *
 * Init also SWEEPS the other file — the ownership-guarded removal it already had
 * for `golem uninit`, aimed at the non-target scope — so flipping the key moves
 * the wiring instead of duplicating it.
 */

import path from "node:path";
import { loadConfig } from "../config/loader.js";

/** Which of Claude Code's two project-scope settings files Golem writes. */
export type ClaudeSettingsScope = "local" | "project";

/** Used when the config cannot be read (see {@link resolveClaudeSettingsScope}). */
export const DEFAULT_CLAUDE_SETTINGS_SCOPE: ClaudeSettingsScope = "local";

/** Both scopes — what uninit walks so it never leaves half the wiring behind. */
export const CLAUDE_SETTINGS_SCOPES: readonly ClaudeSettingsScope[] = ["local", "project"];

const FILENAMES: Readonly<Record<ClaudeSettingsScope, string>> = {
  local: "settings.local.json",
  project: "settings.json",
};

/** `<project>/.claude/<settings file for `scope`>`. */
export function claudeSettingsPathForScope(projectDir: string, scope: ClaudeSettingsScope): string {
  return path.join(projectDir, ".claude", FILENAMES[scope]);
}

/** `<project>/.claude/settings.json` — the COMMITTED file, whatever the scope. */
export function claudeProjectSettingsPath(projectDir: string): string {
  return claudeSettingsPathForScope(projectDir, "project");
}

/** `<project>/.claude/settings.local.json` — the gitignored file, whatever the scope. */
export function claudeLocalSettingsPath(projectDir: string): string {
  return claudeSettingsPathForScope(projectDir, "local");
}

/** The scope init does NOT write — the one to sweep so wiring moves, not duplicates. */
export function otherClaudeSettingsScope(scope: ClaudeSettingsScope): ClaudeSettingsScope {
  return scope === "local" ? "project" : "local";
}

/**
 * Both files in Claude Code's own precedence order (highest first). Readers walk
 * this list rather than the configured scope: the answer to "is this project
 * wired?" must not change just because the write target did.
 */
export function claudeSettingsReadOrder(projectDir: string): readonly string[] {
  return [claudeLocalSettingsPath(projectDir), claudeProjectSettingsPath(projectDir)];
}

/**
 * The configured write scope for `projectDir`.
 *
 * Reads the full settings ladder (user → project → local → `GOLEM_CLAUDE_
 * SETTINGS_SCOPE`), so the key can be pinned wherever the rest of Golem's
 * settings are. A settings file too broken to load falls back to the default
 * rather than throwing: this is called from `golem status` and the status line,
 * and refusing to say where the wiring lives is worse than assuming the default.
 */
export async function resolveClaudeSettingsScope(projectDir: string): Promise<ClaudeSettingsScope> {
  try {
    const { settings } = await loadConfig({ projectDir });
    return settings.claude.settings_scope;
  } catch {
    return DEFAULT_CLAUDE_SETTINGS_SCOPE;
  }
}

/**
 * The settings file Golem writes for `projectDir`. Pass `scope` to target one
 * file explicitly (uninit sweeps both; tests pin one).
 */
export async function claudeSettingsTarget(
  projectDir: string,
  scope?: ClaudeSettingsScope,
): Promise<string> {
  return (await claudeSettingsFiles(projectDir, scope)).target;
}

/** {@link claudeSettingsFiles}' result: the file we write, and the one we don't. */
export interface ClaudeSettingsFiles {
  readonly scope: ClaudeSettingsScope;
  readonly target: string;
  readonly other: string;
}

/**
 * The file Golem writes AND the one it does not, resolved from a single scope
 * decision so the two can never disagree.
 *
 * Writers need both: `target` to write, `other` to sweep (so a scope flip moves
 * the wiring) and to check for a FOREIGN value they would otherwise SHADOW.
 * Shadowing is the failure mode the two-file split adds: a user's own
 * `statusLine` or `defaultMode` in the committed file is not clobbered by a write
 * to the local file, but it stops taking effect all the same, which from the
 * user's chair is the same betrayal with a better audit trail.
 */
export async function claudeSettingsFiles(
  projectDir: string,
  scope?: ClaudeSettingsScope,
): Promise<ClaudeSettingsFiles> {
  const resolved = scope ?? (await resolveClaudeSettingsScope(projectDir));
  return {
    scope: resolved,
    target: claudeSettingsPathForScope(projectDir, resolved),
    other: claudeSettingsPathForScope(projectDir, otherClaudeSettingsScope(resolved)),
  };
}
