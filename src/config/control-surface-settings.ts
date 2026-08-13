/**
 * The SETTINGS third of the control surface: `.golem/settings.json` at
 * user/project/local scope, plus `GOLEM_*` env overrides.
 *
 * Split out of control-surface.ts (R10.1) by STORE, so each store's read half
 * and write half sit together — the same discipline `golem init`/`uninit`
 * needed: a collector and its applier are two halves of one concern and drift
 * apart if separated. The three stores are genuinely independent (the collector
 * is one branch of a `Promise.all`, the applier one arm of a family dispatch),
 * which is what makes this a seam rather than a cut.
 *
 * Consumers keep importing from `control-surface.js`, which re-exports these.
 */

import { getConfig, listConfig, setConfig, unsetConfig } from "../cli/config.js";
import {
  type ApplyControlOptions,
  type ApplyResult,
  type Control,
  type ControlGroup,
  coerceLevel,
  ENV_LOCKED,
  GUIDANCE_SCOPES,
  OPAQUE_LOCKED,
  parseSettingScope,
  restartHintFor,
  SETTING_SCOPES,
  SLIDER_LEVELS,
} from "./control-surface-types.js";
import { ConfigError } from "./errors.js";
import { leafSchema } from "./schema.js";
import {
  enumOptionsFor,
  numericRangeFor,
  sectionMeta,
  sectionsInDisplayOrder,
  settingKind,
  settingMeta,
} from "./ui-model.js";

/** One group per settings section, in {@link sectionsInDisplayOrder}. */
export async function settingControlGroups(shared: {
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
export function settingControl(
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
export async function applySetting(
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
