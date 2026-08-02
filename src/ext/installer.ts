/**
 * R8.14 — `golem ext install/remove/upgrade`: invoke the upstream's own
 * installer at a pinned version, with explicit consent.
 *
 * Golem ships NO third-party bytes and never auto-installs (Decision 53). This
 * module resolves which installer row applies to the current platform, then
 * runs the upstream's installer command (npm, uv, brew, winget, etc.) as an
 * argument array — never a shell string.
 *
 * Design constraints (from the task brief):
 * - Consent is explicit and per-tool — the CLI asks before invoking anything.
 * - Pinned versions only, recorded in the manifest.
 * - Cross-platform: argument-array spawn, no shell strings.
 * - `upgrade` must not be able to move a pin outside its playbook. The Headroom
 *   pin is governed by the T-C4 upgrade playbook (src/compression/index.ts).
 * - Absence of an installer row degrades to a no-op with a reason.
 */

import type { ExtInstaller, ExtManifest } from "./manifest.js";

/**
 * Resolve the installer entry that applies to `platform`.
 *
 * Returns the first match in priority order:
 * 1. An entry whose `platform` is the exact platform name.
 * 2. An entry whose `platform` is `"posix"` (matches darwin + linux).
 * 3. An entry whose `platform` is `"all"`.
 * 4. `null` if no entry applies.
 */
export function resolveInstaller(
  manifest: ExtManifest,
  platform: NodeJS.Platform = process.platform,
): ExtInstaller | null {
  if (manifest.installer === undefined) return null;

  const entries = manifest.installer;
  // 1. exact platform match
  for (const entry of entries) {
    if (entry.platform === platform) return entry;
  }
  // 2. posix matches darwin and linux
  if (platform === "darwin" || platform === "linux") {
    for (const entry of entries) {
      if (entry.platform === "posix") return entry;
    }
  }
  // 3. "all" fallback
  for (const entry of entries) {
    if (entry.platform === "all") return entry;
  }
  return null;
}

/**
 * The action a `golem ext <subcommand>` performs.
 */
export type ExtAction = "install" | "remove" | "upgrade";

/**
 * Resolve the command for a given action, or null when that action is not
 * available for this tool/platform.
 *
 * - `install` always uses the resolved installer's `command`.
 * - `upgrade` uses the entry's `upgrade` if present, otherwise re-runs `install`.
 * - `remove` uses the entry's `remove` if present, otherwise returns null (no
 *   uninstall path is known — the caller reports "not supported").
 */
export function resolveActionCommand(
  entry: ExtInstaller,
  action: ExtAction,
): readonly string[] | null {
  switch (action) {
    case "install":
      return entry.command;
    case "upgrade":
      return entry.upgrade ?? entry.command;
    case "remove":
      return entry.remove ?? null;
  }
}

/**
 * Human-readable summary of what an action will do, for the consent prompt.
 */
export function actionSummary(
  manifest: ExtManifest,
  entry: ExtInstaller | null,
  action: ExtAction,
  _platform: NodeJS.Platform = process.platform,
): string {
  if (entry === null) {
    const available = manifest.installer?.map((e) => e.platform).join(", ") ?? "none";
    return `golem ext ${action} ${manifest.id}: no installer is available for this platform (${available} registered).`;
  }
  const cmd = resolveActionCommand(entry, action);
  const cmdStr = cmd !== null ? cmd.join(" ") : "(no uninstall command)";
  const pinNote = manifest.pin !== undefined ? ` at pin ${manifest.pin}` : "";
  return `golem ext ${action} ${manifest.id}${pinNote}\n  ${cmdStr}`;
}

/**
 * The outcome of attempting an ext action.
 */
export interface ExtActionResult {
  /** Whether the action completed (regardless of exit code). */
  readonly done: boolean;
  /** Exit code of the upstream installer, or null if it could not be spawned. */
  readonly code: number | null;
  /** What happened, for the CLI to print. */
  readonly message: string;
}

/**
 * An installable tool that has no installer row but is a peer (Tier 3a) or
 * bundled (Tier 3b). These are not machine-installable by Golem — the human
 * reads the `install` docs string instead.
 */
export const NOT_MACHINE_INSTALLABLE: readonly string[] = ["caveman", "brevity-profiles"];
