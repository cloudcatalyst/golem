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
 *   affordance (slider.level, proxy.active_account).
 */

import path from "node:path";
import { getConfig, listConfig, setConfig, unsetConfig } from "../cli/config.js";
import { proxyStatus, startDetached, stopProxy } from "../cli/proxy-daemon.js";
import { proxyBaseUrl, readWiringState, type WiringState, wiringGap } from "../cli/proxy-wiring.js";
// `./slider-read.js`, not `./slider.js`: the write path imports cli/init.js and
// costs ~530ms to load, and collecting the surface only needs to READ the level.
// `setSliderLevel` is imported lazily in applyRuntime. (verification-notes §86)
import { getSliderInfo, SLIDER_LEVEL_NAMES } from "../cli/slider-read.js";
import type { StatusReport } from "../cli/status.js";
// `../hooks/guidance.js`, not the `../hooks/index.js` barrel: the barrel pulls
// every hook handler (~446ms vs ~117ms) and all we need here is the feature table
// plus the rule read/write helpers.
import {
  GUIDANCE_FEATURES,
  type GuidanceScope,
  guidanceRuleExists,
  removeGuidanceRule,
  writeGuidanceRule,
} from "../hooks/guidance.js";
import { migrateSliderLevel, type SliderLevel } from "../interfaces/policy.js";
import { ConfigError } from "./errors.js";
import { loadConfig } from "./loader.js";
import { leafSchema } from "./schema.js";
import {
  enumOptionsFor,
  numericRangeFor,
  type SettingKind,
  sectionMeta,
  sectionsInDisplayOrder,
  settingKind,
  settingMeta,
} from "./ui-model.js";
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
const SLIDER_LEVELS: readonly SliderLevel[] = [0, 1, 2, 3];

/** The scopes a settings control accepts, most-local first (what a UI defaults to). */
const SETTING_SCOPES: readonly SettingsScope[] = ["project", "local", "user"];
/** The scopes a guidance rule accepts: committed project rule, or personal. */
const GUIDANCE_SCOPES: readonly GuidanceScope[] = ["project", "user"];

const ENV_LOCKED = (source: string | undefined): string =>
  `set by ${source ?? "an environment variable"} — env overrides every file layer, ` +
  "so a write here would have no effect. Unset it to edit this again.";

// ---------------------------------------------------------------------------
// Collect
// ---------------------------------------------------------------------------

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

/** One group per settings section, in {@link sectionsInDisplayOrder}. */
async function settingControlGroups(shared: {
  projectDir: string;
  userDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<ControlGroup[]> {
  const { entries } = await listConfig(shared);
  const bySection = new Map<string, Control[]>();

  for (const entry of entries) {
    const meta = settingMeta(entry.key);
    // A leaf a runtime control owns is edited there, not twice here.
    if (meta?.ownedBy !== undefined) continue;
    const [section] = entry.key.split(".", 2) as [string, string];
    const control = settingControl(entry.key, entry.value, entry.layer, entry.source);
    if (control === null) continue;
    const list = bySection.get(section);
    if (list === undefined) bySection.set(section, [control]);
    else list.push(control);
  }

  const groups: ControlGroup[] = [];
  for (const section of sectionsInDisplayOrder()) {
    const controls = bySection.get(section);
    if (controls === undefined || controls.length === 0) continue;
    const meta = sectionMeta(section);
    groups.push({
      id: `settings:${section}`,
      title: meta?.title ?? section,
      ...(meta?.summary !== undefined && { summary: meta.summary }),
      tab: "settings",
      controls,
    });
  }
  return groups;
}

/** One settings leaf as a Control; null if the key has no schema (defensive). */
function settingControl(
  key: string,
  value: unknown,
  layer: string,
  source: string | undefined,
): Control | null {
  const [section, leafKey] = key.split(".", 2) as [string, string];
  const schema = leafSchema(section, leafKey);
  if (schema === undefined) return null;
  const meta = settingMeta(key);
  const kind = settingKind(key, schema);
  const options = enumOptionsFor(schema);
  const range = numericRangeFor(schema);
  const locked =
    layer === "env" ? ENV_LOCKED(source) : kind === "opaque" ? OPAQUE_LOCKED : undefined;

  return {
    id: `setting:${key}`,
    family: "setting",
    label: meta?.label ?? key,
    summary: meta?.summary ?? "",
    ...(meta?.detail !== undefined && { detail: meta.detail }),
    kind,
    value,
    ...(options !== undefined && {
      options: options.map((v) => ({ value: v, label: v })),
    }),
    ...(range !== undefined && { range }),
    layer,
    ...(source !== undefined && { source }),
    writableScopes: locked === undefined ? SETTING_SCOPES : [],
    ...(locked !== undefined && { locked }),
    ...(meta?.danger !== undefined && { danger: meta.danger }),
    ...(meta?.restart !== undefined && { restart: meta.restart }),
    advanced: meta?.advanced === true,
  };
}

const OPAQUE_LOCKED =
  "structured value — edit it with the command that owns it (see the description)";

/** The guidance rules, with the scope each is currently enabled at. */
async function guidanceControlGroup(projectDir: string): Promise<ControlGroup> {
  const controls: Control[] = await Promise.all(
    GUIDANCE_FEATURES.map(async (feature): Promise<Control> => {
      const [project, user] = await Promise.all([
        guidanceRuleExists(projectDir, feature.name, "project"),
        guidanceRuleExists(projectDir, feature.name, "user"),
      ]);
      // Presence IS the toggle; the committed project rule wins the display.
      const layer = project ? "project" : user ? "user" : "default";
      return {
        id: `guidance:${feature.name}`,
        family: "guidance",
        label: feature.name,
        summary: feature.summary,
        detail:
          `Writes .claude/rules/golem-${feature.name}.md, which Claude Code auto-loads every ` +
          `session. ${feature.seededByDefault ? "Seeded by `golem init`." : "Opt-in."} ` +
          "Restart or reload Claude Code to pick up a change.",
        kind: "toggle",
        value: project || user,
        layer,
        ...(layer !== "default" && {
          source: path.join(
            projectDir,
            ".claude",
            "rules",
            project ? `golem-${feature.name}.md` : `golem-${feature.name}.local.md`,
          ),
        }),
        writableScopes: GUIDANCE_SCOPES,
        advanced: false,
      };
    }),
  );

  return {
    id: "guidance",
    title: "Guidance rules",
    summary: "Practices Claude Code is told to follow — a rule file's presence is the toggle",
    tab: "guidance",
    controls,
  };
}

/** Slider level, active account, and the proxy daemon. */
async function runtimeControlGroup(shared: {
  projectDir: string;
  userDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<ControlGroup> {
  const [slider, { settings, provenance }] = await Promise.all([
    getSliderInfo(shared),
    loadConfig(shared),
  ]);
  const proxy = await proxyStatus(shared.projectDir, settings.proxy.port);

  const sliderMeta = settingMeta("slider.level");
  const sliderLocked = slider.layer === "env" ? ENV_LOCKED(slider.source) : undefined;
  const sliderControl: Control = {
    id: "runtime:slider",
    family: "runtime",
    label: sliderMeta?.label ?? "Savings level",
    summary: sliderMeta?.summary ?? "",
    ...(sliderMeta?.detail !== undefined && { detail: sliderMeta.detail }),
    kind: "enum",
    value: String(slider.level),
    options: SLIDER_LEVELS.map((level) => ({
      value: String(level),
      label: `${level} ${SLIDER_LEVEL_NAMES[level]}`,
    })),
    layer: slider.layer,
    ...(slider.source !== undefined && { source: slider.source }),
    // The slider is a personal, transient dial: it always writes local scope
    // (Decision 43), so it offers no scope choice.
    writableScopes: sliderLocked === undefined ? ["local"] : [],
    ...(sliderLocked !== undefined && { locked: sliderLocked }),
    ...(sliderMeta?.danger !== undefined && { danger: sliderMeta.danger }),
    restart: "proxy",
    advanced: false,
  };

  // Accounts: the synthetic default (clears default_target) plus each registered
  // gateway. Credentials are never read here — `useAccount` does the preflight.
  const registered = settings.proxy.gateways ?? [];
  const defaultId = settings.proxy.upstream_provider;
  const accountEntry = provenance["inference.default_target"];
  const accountLocked = accountEntry?.layer === "env" ? ENV_LOCKED(accountEntry.source) : undefined;
  const accountControl: Control = {
    id: "runtime:account",
    family: "runtime",
    label: "Active gateway",
    summary: "Which upstream gateway the proxy fronts",
    detail:
      "Switching runs a credential preflight and restarts a running proxy. Credentials live " +
      "in the OS store — add gateways with `golem account add` / `golem account login`.",
    kind: "enum",
    value: settings.inference.default_target ?? defaultId,
    options: [
      { value: defaultId, label: `${defaultId} (default upstream config)` },
      ...registered.map((g) => ({ value: g.id, label: `${g.id} (${g.provider})` })),
    ],
    layer: accountEntry?.layer ?? "default",
    ...(accountEntry?.source !== undefined && { source: accountEntry.source }),
    writableScopes: accountLocked === undefined ? ["project", "local", "user"] : [],
    ...(accountLocked !== undefined && { locked: accountLocked }),
    restart: "proxy",
    advanced: false,
  };

  // R8.32: "running" described the daemon, not the product. A proxy nothing is
  // wired to serves no traffic, so the toggle read `running` while redaction,
  // compression and telemetry were all being bypassed. Same read the CLI does.
  const wiring = await readWiringState(shared.projectDir, proxyBaseUrl(settings.proxy.port)).catch(
    (): WiringState => ({ owner: "none", baseUrl: null }),
  );
  const gap = proxy.running ? wiringGap(wiring, proxyBaseUrl(settings.proxy.port)) : null;
  const proxyControl: Control = {
    id: "runtime:proxy",
    family: "runtime",
    label: "Proxy daemon",
    summary: proxy.running
      ? `${gap === null ? "running" : "running but NOT in the request path"} on port ${proxy.port ?? settings.proxy.port}${proxy.pid !== undefined ? ` (pid ${proxy.pid})` : ""}`
      : `not running (port ${settings.proxy.port})`,
    detail:
      "Claude Code talks to this local proxy. Starting it detaches the daemon; stopping it " +
      "sends traffic nowhere until it is started again." +
      (gap === null ? "" : `\n\n⚠ ${gap.problem}${gap.remedy === null ? "" : ` ${gap.remedy}`}`),
    kind: "toggle",
    value: proxy.running,
    layer: "runtime",
    writableScopes: ["runtime"],
    advanced: false,
  };

  return {
    id: "runtime",
    title: "Runtime",
    summary: "Live state — not stored settings",
    tab: "runtime",
    controls: [sliderControl, accountControl, proxyControl],
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

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

async function applySetting(
  key: string,
  value: unknown,
  scope: string,
  shared: {
    projectDir: string;
    userDir?: string;
    env?: Readonly<Record<string, string | undefined>>;
  },
): Promise<ApplyResult> {
  const target = parseSettingScope(scope);
  const current = await getConfig(key, shared);
  if (current.layer === "env") {
    throw new ConfigError(`cannot change ${key}: ${ENV_LOCKED(current.source)}`, { key });
  }

  // `null` means "remove this key from the scope so lower layers apply again".
  if (value === null) {
    const result = await unsetConfig(target, key, shared);
    return {
      id: `setting:${key}`,
      value: result.effective.value,
      message: `${key} removed from ${target} scope — now ${JSON.stringify(result.effective.value)} (${result.effective.layer})`,
      file: result.file,
      ...restartHintFor(key),
    };
  }

  // setConfig parses from a string, exactly as `golem config set` does, so the
  // panel and the CLI accept and validate identical input.
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const result = await setConfig(target, key, raw, shared);
  return {
    id: `setting:${key}`,
    value: result.effective.value,
    message: `${key} = ${JSON.stringify(result.value)} (${target} scope)`,
    file: result.file,
    ...(result.overriddenBy !== undefined && {
      overridden: `a higher layer wins — effective value is ${JSON.stringify(result.overriddenBy.value)} from ${result.overriddenBy.layer}`,
    }),
    ...restartHintFor(key),
  };
}

async function applyGuidance(
  name: string,
  value: unknown,
  scope: string,
  projectDir: string,
): Promise<ApplyResult> {
  const feature = GUIDANCE_FEATURES.find((f) => f.name === name);
  if (feature === undefined) {
    throw new ConfigError(
      `unknown guidance feature "${name}" (try: ${GUIDANCE_FEATURES.map((f) => f.name).join(", ")})`,
      { key: name },
    );
  }
  const target: GuidanceScope = scope === "user" ? "user" : "project";

  if (value === true) {
    const action = await writeGuidanceRule(projectDir, feature, target);
    return {
      id: `guidance:${name}`,
      value: true,
      message: `${name} enabled (${target} scope)`,
      file: action.path,
      restartHint: "restart or reload Claude Code to pick up the rule",
    };
  }
  // Disabling removes BOTH scopes unless the personal scope was asked for
  // explicitly — otherwise a committed rule would silently keep it on.
  const action = await removeGuidanceRule(projectDir, name, scope === "user" ? "user" : "both");
  return {
    id: `guidance:${name}`,
    value: false,
    message:
      action.kind === "skip" ? `${name} was already off` : `${name} disabled (${action.path})`,
    ...(action.kind !== "skip" && { file: action.path }),
    restartHint: "restart or reload Claude Code to drop the rule",
  };
}

/**
 * Runtime controls decide their own storage (the slider always writes local
 * scope per Decision 43; the account writes project scope; the proxy writes
 * nothing), so the caller's `scope` is deliberately ignored here.
 */
async function applyRuntime(
  name: string,
  value: unknown,
  _scope: string,
  options: ApplyControlOptions,
  shared: {
    projectDir: string;
    userDir?: string;
    env?: Readonly<Record<string, string | undefined>>;
  },
): Promise<ApplyResult> {
  switch (name) {
    case "slider": {
      const level = migrateSliderLevel(coerceLevel(value));
      // Lazy: the write path imports cli/init.js (it can activate a project on the
      // first level choice), which is exactly the ~530ms this module avoids paying
      // just to display a level.
      const { setSliderLevel } = await import("../cli/slider.js");
      const result = await setSliderLevel(level, shared);
      return {
        id: "runtime:slider",
        value: String(result.effective.level),
        message:
          `slider level ${result.effective.level} (${result.effective.name})` +
          (result.justInitialized === true ? " — project initialized" : ""),
        file: result.file,
        ...(result.overriddenBy !== undefined && {
          overridden: `a higher layer wins — effective level is ${result.overriddenBy.level} from ${result.overriddenBy.layer}`,
        }),
      };
    }
    case "account": {
      const { settings } = await loadConfig(shared);
      const raw = typeof value === "string" ? value : String(value);
      // The synthetic default id and "none" both clear `active_account`.
      const target =
        raw === "none" || raw === "" || raw === settings.proxy.upstream_provider ? null : raw;
      const result = await switchAccount(shared.projectDir, target, options);
      return {
        id: "runtime:account",
        value: result.active ?? settings.proxy.upstream_provider,
        message:
          result.active === null
            ? `switched to the default upstream config (${settings.proxy.upstream_provider})`
            : `switched to account ${result.active}`,
        restartHint: "a running proxy was restarted onto the new upstream",
      };
    }
    case "proxy": {
      const { settings } = await loadConfig(shared);
      if (value === true) {
        const script = options.cliPath;
        if (script === undefined || script === "") {
          throw new ConfigError(
            "cannot start the proxy: no CLI path available (start it with `golem proxy`)",
            { key: "runtime:proxy" },
          );
        }
        const pid = await startDetached(shared.projectDir, settings.proxy.port, script);
        if (pid === null) {
          throw new ConfigError(
            `the proxy did not come up on port ${settings.proxy.port} — run \`golem proxy\` to see why`,
            { key: "runtime:proxy" },
          );
        }
        return {
          id: "runtime:proxy",
          value: true,
          message: `proxy started on port ${settings.proxy.port} (pid ${pid})`,
        };
      }
      const stopped = await stopProxy(shared.projectDir);
      return {
        id: "runtime:proxy",
        value: false,
        message: stopped === null ? "proxy was not running" : `proxy stopped (pid ${stopped})`,
      };
    }
    default:
      throw new ConfigError(`unknown runtime control "${name}"`, { key: name });
  }
}

/**
 * `useGateway` lives in cli/gateways.ts, which pulls in the credential stores.
 * Imported lazily so merely *rendering* the panel never loads them (and so the
 * OS keychain is only consulted when a gateway is actually switched).
 *
 * Named `switchAccount`, not `useGatewayLazy`: a `use`-prefixed function trips
 * Biome's react/useHookAtTopLevel rule, which this file (now that the repo
 * compiles JSX) is checked by.
 */
async function switchAccount(
  projectDir: string,
  id: string | null,
  options: ApplyControlOptions,
): Promise<{ readonly active: string | null }> {
  const { useGateway } = await import("../cli/gateways.js");
  return useGateway(projectDir, id, options.nowIso ?? new Date().toISOString(), {
    ...(options.assumeYes !== undefined && { assumeYes: options.assumeYes }),
    ...(options.env !== undefined && { env: options.env }),
  });
}

function parseSettingScope(scope: string): SettingsScope {
  if (scope === "user" || scope === "project" || scope === "local") return scope;
  throw new ConfigError(`invalid scope "${scope}" (expected user, project, or local)`, {
    key: scope,
  });
}

function coerceLevel(value: unknown): number {
  const num = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(num) || num < 0 || num > 5) {
    throw new ConfigError(`invalid slider level "${String(value)}" (expected 0–3)`, {
      key: "slider.level",
    });
  }
  return num;
}

function restartHintFor(key: string): { restartHint?: string } {
  const restart = settingMeta(key)?.restart;
  if (restart === "proxy") return { restartHint: "run `golem proxy restart` to apply" };
  if (restart === "mcp") return { restartHint: "reconnect the golem MCP server in Claude Code" };
  return {};
}
