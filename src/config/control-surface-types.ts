// `../hooks/guidance.js`, not the `../hooks/index.js` barrel: the barrel pulls
// every hook handler (~446ms vs ~117ms) and all we need here is the feature table
// plus the rule read/write helpers.
import type { GuidanceScope } from "../hooks/guidance.js";
import type { SliderLevel } from "../interfaces/policy.js";
import { ConfigError } from "./errors.js";
import { type SettingKind, settingMeta } from "./ui-model.js";
import type { SettingsScope } from "./write-setting.js";

/** Which store backs a control (and therefore which write path applies). */
export type ControlFamily = "setting" | "guidance" | "runtime";
/** A control's widget kind. `action` is a button (start/stop the proxy). */
export type ControlKind = SettingKind | "action";
export interface ControlOption {
  readonly value: string;
  readonly label: string;
}
export interface Control {
  /**
   * Stable id: `setting:<section>.<key>`, `guidance:<feature>`, or
   * `runtime:<name>`. This is what {@link applyControl} takes, and what a webview
   * round-trips, so it must not change between releases.
   */
  readonly id: string;
  readonly family: ControlFamily;
  readonly label: string;
  readonly summary: string;
  readonly detail?: string;
  readonly kind: ControlKind;
  /** Current effective value: boolean for toggles, string/number, or a raw JSON value. */
  readonly value: unknown;
  /** Allowed values for `enum` kinds, in display order. */
  readonly options?: readonly ControlOption[];
  /** Inclusive bounds for `number` kinds, when the schema declares them. */
  readonly range?: { readonly min?: number; readonly max?: number; readonly int: boolean };
  /** Which layer supplied the effective value: default | user | project | local | env. */
  readonly layer: string;
  /** The file path or env var name behind that layer. */
  readonly source?: string;
  /** Scopes this control can be written to, in the order a UI should offer them. */
  readonly writableScopes: readonly string[];
  /** Set when the control cannot be written; the string explains why. */
  readonly locked?: string;
  /** Loud warning to confirm before applying (e.g. slider 0 turns redaction off). */
  readonly danger?: string;
  /** What must restart before the change takes effect. */
  readonly restart?: "proxy" | "mcp";
  readonly advanced: boolean;
}
export interface ControlGroup {
  /** `settings:<section>`, `guidance`, or `runtime`. */
  readonly id: string;
  readonly title: string;
  readonly summary?: string;
  /** Which tab this group belongs to. */
  readonly tab: ControlTab;
  readonly controls: readonly Control[];
}
/** The panel's top-level tabs. */
export type ControlTab = "settings" | "guidance" | "runtime";
export const CONTROL_TABS: readonly { readonly id: ControlTab; readonly title: string }[] = [
  { id: "settings", title: "Settings" },
  { id: "guidance", title: "Guidance" },
  { id: "runtime", title: "Runtime" },
];
export interface ControlSurfaceOptions {
  readonly projectDir: string;
  /** CLI version for the header; `golem status` reports the same string. */
  readonly version: string;
  readonly userDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Forwarded to collectStatus — keep short so the panel opens fast. */
  readonly probeTimeoutMs?: number;
  /** Test injection, forwarded to collectStatus. */
  readonly localProbe?: (
    projectDir: string,
    baseUrl: string,
  ) => Promise<{ readonly reachable: boolean; readonly coderModel?: string }>;
  /**
   * Include the header in the returned surface. Default false — building it costs
   * ~400ms of module load plus a proxy/Ollama probe, which the `golem` control panel
   * deliberately keeps off its first paint (see {@link ControlSurface.header}).
   * `golem config schema --json` passes true.
   */
  readonly withHeader?: boolean;
}
/**
 * The selectable slider levels. Declared here rather than in interfaces/policy.ts
 * — that file is a frozen contract (CLAUDE.md), and this is a display concern.
 * `SliderLevel` keeps it honest if the contract's range ever changes.
 */
export const SLIDER_LEVELS: readonly SliderLevel[] = [0, 1, 2, 3];
/** The scopes a settings control accepts, most-local first (what a UI defaults to). */
export const SETTING_SCOPES: readonly SettingsScope[] = ["project", "local", "user"];
/** The scopes a guidance rule accepts: committed project rule, or personal. */
export const GUIDANCE_SCOPES: readonly GuidanceScope[] = ["project", "user"];
export const ENV_LOCKED = (source: string | undefined): string =>
  `set by ${source ?? "an environment variable"} — env overrides every file layer, ` +
  "so a write here would have no effect. Unset it to edit this again.";

// ---------------------------------------------------------------------------
// Collect
// ---------------------------------------------------------------------------
export const OPAQUE_LOCKED =
  "structured value — edit it with the command that owns it (see the description)";
export interface ApplyResult {
  readonly id: string;
  /** The value actually applied (after coercion/validation). */
  readonly value: unknown;
  /** Human-readable confirmation, suitable for a status line. */
  readonly message: string;
  /** Where it was written, when a file was written. */
  readonly file?: string;
  /** Set when a higher-precedence layer overrides the value just written. */
  readonly overridden?: string;
  /** Set when something must restart before the change takes effect. */
  readonly restartHint?: string;
}
export interface ApplyControlOptions extends ControlSurfaceOptions {
  /** Skip the account-switch credential preflight (mirrors `--yes`). */
  readonly assumeYes?: boolean;
  /**
   * Path of the CLI script used to spawn the proxy daemon — `process.argv[1]`
   * for a normal invocation. Required only to START the proxy.
   */
  readonly cliPath?: string;
  /** Injected clock for the account audit log. */
  readonly nowIso?: string;
}
export function parseSettingScope(scope: string): SettingsScope {
  if (scope === "user" || scope === "project" || scope === "local") return scope;
  throw new ConfigError(`invalid scope "${scope}" (expected user, project, or local)`, {
    key: scope,
  });
}
export function coerceLevel(value: unknown): number {
  const num = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(num) || num < 0 || num > 5) {
    throw new ConfigError(`invalid slider level "${String(value)}" (expected 0–3)`, {
      key: "slider.level",
    });
  }
  return num;
}
export function restartHintFor(key: string): { restartHint?: string } {
  const restart = settingMeta(key)?.restart;
  if (restart === "proxy") return { restartHint: "run `golem proxy restart` to apply" };
  if (restart === "mcp") return { restartHint: "reconnect the golem MCP server in Claude Code" };
  return {};
}
