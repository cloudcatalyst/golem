/**
 * R13.3 — the settings blob a hosted session is spawned with.
 *
 * ## Why the host injects its own settings
 *
 * The obvious design is to let the hosted session pick up the project's
 * `.claude/settings.json`, which `golem init` already wires. It does — §142 item
 * 5 measured that hooks fire in a hosted session via cwd alone. But that makes
 * the host's enforcement conditional on the *guest* wiring being present and
 * un-tampered-with: `golem autonomy unwire` in that project, or a teammate's
 * settings file, and a session Golem itself spawned would run ungated.
 *
 * `claude --settings <file-or-json>` takes an inline JSON string, and
 * **measured 2026-08-29 (verification-notes §147, client 2.1.246): it wires
 * hooks for a session whose project has none.** So the host supplies the gate
 * itself and does not care what the project's settings say.
 *
 * ## Why `PreToolUse` and not `PermissionRequest`
 *
 * This is the finding that changed the design, and it is the opposite of R12.12's
 * conclusion for the guest path — for a good reason.
 *
 * R12.12 moved the *guest* gate to `PermissionRequest` because an interactive
 * session opens a dialog, and a dialog is what a connected channel can answer on
 * the developer's behalf. That reasoning is about dialogs.
 *
 * A hosted session has no dialog and no human at its terminal. `PermissionRequest`
 * fires only "when Claude Code is about to ask you for permission" — and in
 * `--permission-mode default`, a great many calls never ask. Measured (§147): a
 * plain `echo` inside the session's own cwd ran to completion with a
 * `PermissionRequest` deny hook installed **and never fired it**. Enforcing there
 * would have been enforcement that silently does nothing for the common case.
 *
 * `PreToolUse` fires before *every* tool call, permission needed or not, and its
 * flat `permissionDecision: "deny"` stops the call with the reason delivered to
 * the model as the tool result — measured in the same run. That is the host's
 * enforcement point.
 *
 * (Note the shapes differ, and the wrong one is a silent no-op: `PreToolUse`
 * takes a FLAT `permissionDecision` + `permissionDecisionReason`;
 * `PermissionRequest` nests `decision.behavior` + `message`.)
 */

/** The hook command a hosted session runs before every tool call. */
export const HOST_GATE_HOOK_COMMAND = "golem hook host-gate";

/** Seconds. The handler classifies one call and writes one log line. */
export const HOST_GATE_TIMEOUT_SECONDS = 20;

export interface HostSettingsOptions {
  /** The hosted session's id, threaded to the hook so its log lines are attributable. */
  readonly sessionId: string;
  /** Override the hook command (tests point this at a built handler). */
  readonly hookCommand?: string;
}

/**
 * The settings object passed to `--settings`.
 *
 * Deliberately MINIMAL. Everything not named here is left to the project's own
 * settings, which the runner still loads — the host is adding a gate it refuses
 * to run without, not replacing the developer's configuration. In particular the
 * PostToolUse CCR hook, the status line and the MCP wiring are untouched, so a
 * hosted session behaves like the developer's own except that it cannot perform
 * a destructive or outward act.
 */
export function hostSettings(options: HostSettingsOptions): Record<string, unknown> {
  const command = `${options.hookCommand ?? HOST_GATE_HOOK_COMMAND} --session ${options.sessionId}`;
  return {
    hooks: {
      PreToolUse: [
        {
          hooks: [
            {
              type: "command",
              command,
              timeout: HOST_GATE_TIMEOUT_SECONDS,
              // MUST be synchronous: an async hook does not block, and a gate
              // that does not block is a log with extra steps.
              async: false,
            },
          ],
        },
      ],
    },
  };
}

/** The `--settings` argument value: the blob as a single JSON string. */
export function hostSettingsArg(options: HostSettingsOptions): string {
  return JSON.stringify(hostSettings(options));
}
