/**
 * Decision 52 — `golem brevity` / `golem compression`: the two dials the slider
 * became a preset over.
 *
 * Reads go through the config loader so provenance says WHICH layer set the
 * value, exactly like `golem slider`. Writes go to the LOCAL scope
 * (`<project>/.golem/settings.local.json`, gitignored) for the same reason the
 * slider does (Decision 43): a dial you flip while experimenting must not dirty
 * the committed `settings.json`. Use `golem config set brevity.level <v>
 * --scope project` when a pin IS a project decision worth committing.
 *
 * Import weight matters here (Decision 51 / verification-notes §86): this module
 * is pulled in by `golem status` and the status line, so it depends only on the
 * config loader — never on `./init.js` or the hooks barrel.
 */

import { type LayerName, loadConfig, writeSetting } from "../config/index.js";
import {
  type BrevityDial,
  type BrevityLevel,
  brevityPresetForLevel,
  resolveBrevity,
  resolveCompressionLevel,
  type SliderLevel,
} from "../interfaces/policy.js";
import { SLIDER_LEVEL_NAMES } from "./slider-read.js";

export type DialKind = "brevity" | "compression";

/** Accepted values per dial, in display order. `auto` first — it is the default. */
export const DIAL_VALUES: Readonly<Record<DialKind, readonly string[]>> = {
  brevity: ["auto", "off", "lite", "full", "ultra"],
  // 0 is absent deliberately: passthrough belongs to the slider, where
  // redaction-off is surfaced loudly (see schema.ts and policy.ts).
  compression: ["auto", "1", "2", "3"],
};

export const DIAL_SETTING_KEY: Readonly<Record<DialKind, string>> = {
  brevity: "brevity.level",
  compression: "compression.level",
};

/** The effective state of one dial, with enough context to render provenance. */
export interface DialInfo {
  readonly kind: DialKind;
  /** The configured value: `"auto"` or a pinned value. */
  readonly setting: string;
  /** The value actually in force once the slider preset is applied. */
  readonly effective: string;
  /** True when the slider is NOT driving this dial. */
  readonly pinned: boolean;
  /** The slider level the preset was read from. */
  readonly sliderLevel: SliderLevel;
  readonly layer: LayerName;
  readonly source?: string;
}

export interface DialReadOptions {
  readonly projectDir: string;
  readonly userDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export async function getDialInfo(kind: DialKind, options: DialReadOptions): Promise<DialInfo> {
  const { settings, provenance } = await loadConfig({
    projectDir: options.projectDir,
    ...(options.userDir !== undefined && { userDir: options.userDir }),
    ...(options.env !== undefined && { env: options.env }),
  });
  const sliderLevel = settings.slider.level;
  const setting = kind === "brevity" ? settings.brevity.level : settings.compression.level;
  const effective =
    kind === "brevity"
      ? resolveBrevity(sliderLevel, setting as BrevityDial)
      : String(
          resolveCompressionLevel(
            sliderLevel,
            setting === "auto" ? "auto" : (Number(setting) as SliderLevel),
          ),
        );
  const entry = provenance[DIAL_SETTING_KEY[kind]];
  return {
    kind,
    setting,
    effective,
    pinned: setting !== "auto",
    sliderLevel,
    layer: entry?.layer ?? "default",
    ...(entry?.source !== undefined && { source: entry.source }),
  };
}

/**
 * One-line render of a dial's state, shared by every surface so they cannot
 * drift. A pinned dial ALWAYS says so — a pin that looked like a preset would
 * be worse than no pin at all (Decision 52).
 */
export function describeDial(info: DialInfo): string {
  const label = info.kind === "brevity" ? "brevity" : "compression";
  if (!info.pinned) {
    return `${label} ${info.effective} (auto — follows slider ${info.sliderLevel})`;
  }
  // The shipped default for brevity is `off`, which is technically "not auto" —
  // but calling that "pinned" implies someone chose it. Distinguish the two, or
  // a fresh install looks like it has a deliberate override it never got.
  if (info.layer === "default") {
    return `${label} ${info.effective} (default)`;
  }
  return `${label} ${info.effective} (pinned)`;
}

export class DialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DialError";
  }
}

export interface SetDialResult {
  readonly kind: DialKind;
  readonly value: string;
  readonly file: string;
  readonly info: DialInfo;
  /** Set when a higher settings layer overrides the value just written. */
  readonly overriddenBy?: { readonly layer: LayerName; readonly source?: string };
}

export interface DialWriteOptions extends DialReadOptions {
  /** Write to the committed project scope instead of the gitignored local one. */
  readonly project?: boolean;
}

export async function setDial(
  kind: DialKind,
  value: string,
  options: DialWriteOptions,
): Promise<SetDialResult> {
  const allowed = DIAL_VALUES[kind];
  if (!allowed.includes(value)) {
    throw new DialError(
      `invalid ${kind} value "${value}" — expected one of: ${allowed.join(", ")}` +
        (kind === "compression" && value === "0"
          ? "\n(level 0 is the slider's passthrough bypass, not a compression pin: use `golem slider 0`)"
          : ""),
    );
  }
  const file = await writeSetting(
    options.project === true ? "project" : "local",
    DIAL_SETTING_KEY[kind],
    value,
    {
      projectDir: options.projectDir,
      ...(options.userDir !== undefined && { userDir: options.userDir }),
    },
  );
  const info = await getDialInfo(kind, options);
  const scope = options.project === true ? "project" : "local";
  return {
    kind,
    value,
    file,
    info,
    ...(info.layer !== scope && {
      overriddenBy: {
        layer: info.layer,
        ...(info.source !== undefined && { source: info.source }),
      },
    }),
  };
}

/**
 * Human explanation of what a brevity value will do, printed on set so the user
 * is never surprised by a change to how the model talks.
 */
export function brevityEffectNote(effective: BrevityLevel, sliderLevel: SliderLevel): string {
  if (effective === "off") {
    return (
      "brevity is OFF — replies are unchanged. " +
      `(slider ${sliderLevel} (${SLIDER_LEVEL_NAMES[sliderLevel]}) presets brevity to ` +
      `${brevityPresetForLevel(sliderLevel)}; set \`auto\` to follow it.)`
    );
  }
  const shape =
    effective === "lite"
      ? "drops filler and preamble, keeps full sentences"
      : effective === "full"
        ? "telegraphic — fragments, no preamble or recap"
        : "maximum compression — fragments only, minimum function words";
  return (
    `replies will be ${effective}: ${shape}. Code, commands, paths and errors stay verbatim. ` +
    "This changes OUTPUT tokens only — run `golem stats --brevity` to see whether it pays here."
  );
}
