/**
 * The control surface — one list of togglable/editable controls that every Golem
 * UI renders from: the `golem` terminal panel, `golem config schema --json`,
 * and the VS Code webview.
 *
 * Golem's user-facing state lives in three unrelated stores, each with its own
 * scopes and its own write path:
 *
 *   1. SETTINGS   `.golem/settings.json` at user/project/local scope, plus
 *                 `GOLEM_*` env overrides — validated by schema.ts, written by
 *                 writeSetting(). Described for humans by ui-model.ts.
 *   2. GUIDANCE   `.claude/rules/golem-<name>.md` — presence of the file *is* the
 *                 toggle (project scope committed; `.local.md` personal).
 *   3. RUNTIME    the slider level, the active account, and whether the proxy
 *                 daemon is up — each with its own side effects (notify the
 *                 proxy, credential preflight, spawn/kill).
 *
 * This module flattens all three into {@link Control} rows and routes writes back
 * to the existing implementations. It ADDS no persistence logic of its own: every
 * write delegates to setConfig/writeGuidanceRule/setSliderLevel/useAccount/
 * startDetached, so the panel cannot bypass a validation or a side effect that
 * the CLI performs.
 *
 * Two rules the UIs depend on:
 * - A control whose effective value comes from the `env` layer is reported with
 *   {@link Control.locked} set and refuses writes — writing a file layer that env
 *   overrides would look successful and change nothing.
 * - A settings leaf with {@link SettingMeta.ownedBy} is omitted from the settings
 *   groups, because a runtime control edits the same key with a better
 *   affordance (slider.level, inference.default_target).
 */

import path from "node:path";

export * from "./control-surface-types.js";

import type { StatusReport } from "../cli/status.js";
import { applyGuidance, guidanceControlGroup } from "./control-surface-guidance.js";
import { applyRuntime, runtimeControlGroup } from "./control-surface-runtime.js";
import { applySetting, settingControlGroups } from "./control-surface-settings.js";
import type {
  ApplyControlOptions,
  ApplyResult,
  ControlGroup,
  ControlSurfaceOptions,
} from "./control-surface-types.js";
import { ConfigError } from "./errors.js";
import { loadConfig } from "./loader.js";

export interface ControlSurface {
  /**
   * The info header: exactly what `golem status` reports (no extra probing).
   *
   * **Null until it arrives.** Building it needs `../cli/status.js`, whose module
   * graph (init.js → the hooks barrel, proxy, update, the local-model probe) costs
   * ~400ms to load plus ~265ms of probing — so the panel paints its controls first
   * and calls {@link collectHeader} after mounting, rather than making the whole UI
   * wait on a proxy probe. `golem config schema --json`, which has no first-paint
   * to protect, asks for it up front.
   */
  readonly header: StatusReport | null;
  readonly groups: readonly ControlGroup[];
  /** Config-load warnings (unknown env vars, unknown account, …). */
  readonly warnings: readonly string[];
}

/**
 * Build the control surface: every group, and (only if `withHeader`) the header.
 *
 * Without the header this touches nothing more expensive than the config files,
 * the `.claude/rules/` directory, and a pid-file/port check — which is what makes
 * the panel's first paint fast. Call {@link collectHeader} for the rest.
 */
export async function collectControlSurface(
  options: ControlSurfaceOptions,
): Promise<ControlSurface> {
  const projectDir = path.resolve(options.projectDir);
  const shared = {
    projectDir,
    ...(options.userDir !== undefined && { userDir: options.userDir }),
    ...(options.env !== undefined && { env: options.env }),
  };

  const [header, settingsGroups, guidance, runtime] = await Promise.all([
    options.withHeader === true ? collectHeader(options) : Promise.resolve(null),
    settingControlGroups(shared),
    guidanceControlGroup(projectDir),
    runtimeControlGroup(shared),
  ]);

  return {
    header,
    groups: [...settingsGroups, guidance, runtime].filter((g) => g.controls.length > 0),
    // Without a header, the load warnings come from the config read itself.
    warnings: header?.warnings ?? (await loadConfig(shared)).warnings,
  };
}

/**
 * The info header — `golem status`'s report, unchanged.
 *
 * `../cli/status.js` is imported LAZILY: its graph (init.js → the hooks barrel,
 * plus proxy, update, and the local-model probe) is ~400ms to load, and the panel
 * mounts before asking for any of it.
 */
export async function collectHeader(options: ControlSurfaceOptions): Promise<StatusReport> {
  const { collectStatus } = await import("../cli/status.js");
  return collectStatus({
    projectDir: path.resolve(options.projectDir),
    version: options.version,
    ...(options.userDir !== undefined && { userDir: options.userDir }),
    ...(options.env !== undefined && { env: options.env }),
    ...(options.probeTimeoutMs !== undefined && { probeTimeoutMs: options.probeTimeoutMs }),
    ...(options.localProbe !== undefined && { localProbe: options.localProbe }),
  });
}

/**
 * Apply a change to one control. `scope` is one of the control's
 * {@link Control.writableScopes}; it is ignored by runtime controls that own
 * their own storage decision (the slider always writes local scope).
 *
 * Throws {@link ConfigError} for an unknown id, a locked control, or an
 * out-of-schema value — the caller surfaces the message and leaves the row as it
 * was, rather than showing an optimistic value that never persisted.
 */
export async function applyControl(
  id: string,
  value: unknown,
  scope: string,
  options: ApplyControlOptions,
): Promise<ApplyResult> {
  const projectDir = path.resolve(options.projectDir);
  const shared = {
    projectDir,
    ...(options.userDir !== undefined && { userDir: options.userDir }),
    ...(options.env !== undefined && { env: options.env }),
  };

  const separator = id.indexOf(":");
  const family = separator === -1 ? "" : id.slice(0, separator);
  const name = separator === -1 ? "" : id.slice(separator + 1);

  switch (family) {
    case "setting":
      return applySetting(name, value, scope, shared);
    case "guidance":
      return applyGuidance(name, value, scope, projectDir);
    case "runtime":
      return applyRuntime(name, value, scope, options, shared);
    default:
      throw new ConfigError(
        `unknown control "${id}" (expected setting:<key>, guidance:<name>, or runtime:<name>)`,
        { key: id },
      );
  }
}
