/**
 * Keeps a project's Claude Code wiring — hooks, statusLine, defaultMode, the
 * MCP permission pre-approval, and the proxy `env` block — in sync with the
 * INSTALLED `golem` version, the moment either the proxy daemon or a Claude
 * Code session next runs. Also — UNCONDITIONALLY, not gated on a version
 * bump — keeps the persona-generated artifacts (`.claude/agents/golem-<id>.md`,
 * `.claude/rules/golem-prefer-persona-agents.md`) in sync with
 * `inference.personas`, since a settings edit has nothing to do with whether
 * the installed `golem` version changed.
 *
 * This is what lets `.claude/settings.local.json` (or the committed
 * `.claude/settings.json`, under `claude.settings_scope=project`) stay
 * current WITHOUT needing to be shared via git (see the .gitignore review,
 * 2026-09-17, and USER decision the same day): whichever machine happens to
 * run the newer `golem` first reconciles itself on its own next start.
 *
 * `migrateOnVersionChange` (config/migrate-files.ts) already does the "did
 * the version move?" check and reconciles Golem's OWN settings keys. This
 * wraps it once more to ALSO re-run the Claude Code wiring writers
 * (`configureClaudeSettings` / `wireHooks`) when it did. Both writers are
 * already idempotent per-entry — each strips its own prior version by
 * command name before re-adding (settings-writer.ts) — so re-running them on
 * every version bump is safe, and never destructive to a setting outside
 * Golem's own keys.
 *
 * Two independent callers share this (both wrapped in their own fail-safe
 * catch, same philosophy as `migrateOnVersionChange`'s own doc comment —
 * neither should be stoppable by settings bookkeeping):
 *   - `golem proxy`'s own startup — covers a daemon that just (re)started.
 *   - `golem hook session-start` — covers every single Claude Code session,
 *     so a daemon that stays running for weeks doesn't leave the wiring
 *     stale until it happens to restart.
 *
 * Both read/write the SAME `.golem/state/version.json` stamp
 * (`migrateOnVersionChange` owns that write), so whichever runs first after a
 * version bump does the work and the other sees `ran: false` and no-ops —
 * safe by construction, not by ordering. The persona sync runs on EVERY call
 * regardless — it has no version stamp of its own, because "did the persona
 * roster change" is not the same question as "did the version change", and a
 * project can edit `inference.personas` between version bumps.
 */

import { migrateOnVersionChange } from "../config/index.js";
import type { InitAction } from "./init.js";
import { configureClaudeSettings } from "./init-claude-settings.js";
import { wireHooks } from "./init-hooks.js";
import { syncPersonaArtifacts } from "./persona-sync.js";
import { proxyBaseUrl } from "./proxy-wiring.js";

export interface VersionSyncResult {
  /** True when the stamp named a different (or no) version and the sweep ran. */
  readonly ran: boolean;
  /** The version stamped before this run; null on a project with none. */
  readonly previous: string | null;
  /** Golem's own settings-key migration report lines (unchanged shape). */
  readonly configLines: readonly string[];
  /** Claude Code wiring actions taken; empty when `ran` is false. */
  readonly claudeActions: readonly InitAction[];
  /**
   * Persona-artifact sync actions — ALWAYS populated (when non-empty),
   * independent of `ran`. Unlike `claudeActions`, this never depends on a
   * version bump: see the module doc comment.
   */
  readonly personaActions: readonly InitAction[];
}

/**
 * Re-run the Claude Code wiring writers for `projectDir`. Best-effort: a
 * genuine conflict (e.g. a foreign gateway's `ANTHROPIC_BASE_URL` already set
 * by something else) is surfaced loudly by `golem init` itself when the user
 * runs it directly — neither the proxy daemon starting nor a SessionStart
 * hook should be crashable by settings bookkeeping.
 */
export async function syncClaudeWiring(
  projectDir: string,
  proxyPort: number,
): Promise<readonly InitAction[]> {
  try {
    const baseUrl = proxyBaseUrl(proxyPort);
    return [
      ...(await configureClaudeSettings({ projectDir }, baseUrl, false)),
      ...(await wireHooks(projectDir, false)),
    ];
  } catch {
    return [];
  }
}

/**
 * Run the version-drift check and, if the stamp moved, reconcile both
 * Golem's own settings AND Claude Code's wiring for `projectDir`. Self
 * contained — the single call `golem hook session-start` needs.
 *
 * `golem proxy`'s own startup calls {@link syncClaudeWiring} directly instead,
 * gated on its OWN earlier `migrateOnVersionChange` result, so the config-key
 * sweep there can keep running before settings are loaded (R9.13) without
 * this function re-running that sweep a second time.
 */
export async function syncProjectVersion(options: {
  readonly projectDir: string;
  readonly version: string;
  readonly proxyPort: number;
}): Promise<VersionSyncResult> {
  const { projectDir, version, proxyPort } = options;

  // Unconditional and BEFORE the version-gated sweep below — a persona-config
  // edit has nothing to do with whether `golem` itself was upgraded, so this
  // must not wait for a version bump to reach disk. Own try/catch, same
  // philosophy as `syncClaudeWiring`'s: neither should be stoppable by
  // settings bookkeeping.
  let personaActions: readonly InitAction[] = [];
  try {
    personaActions = await syncPersonaArtifacts(projectDir, false);
  } catch {
    personaActions = [];
  }

  const configSweep = await migrateOnVersionChange({ projectDir, version });
  if (!configSweep.ran) {
    return {
      ran: false,
      previous: configSweep.previous,
      configLines: configSweep.lines,
      claudeActions: [],
      personaActions,
    };
  }
  const claudeActions = await syncClaudeWiring(projectDir, proxyPort);
  return {
    ran: true,
    previous: configSweep.previous,
    configLines: configSweep.lines,
    claudeActions,
    personaActions,
  };
}

/** Render one Claude wiring action the same way `configLines` read: one line, no header. */
export function renderClaudeAction(action: InitAction): string {
  return `${action.path} — ${action.detail}`;
}
