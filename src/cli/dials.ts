/**
 * `golem brevity` / `golem compression` — the two dials, which since R11.1
 * (ADR-0004) are the WHOLE control surface for the pipeline's behaviour.
 *
 * They used to be pins over a slider preset, so every value had an `auto` state
 * and every read had to explain whether the slider or the pin was in force. The
 * slider is gone: a dial's configured value IS its value, and the only remaining
 * gap between configured and effective is Decision 31's genuine one — a caching
 * upstream degrades compression 2/3 to lossless (see `resolveEffectiveCompression`).
 *
 * Reads go through the config loader so provenance says WHICH layer set the
 * value. Writes go to the LOCAL scope (`<project>/.golem/settings.local.json`,
 * gitignored) because a dial you flip while experimenting must not dirty the
 * committed `settings.json` (Decision 43). Use
 * `golem config set compression.level <v> --scope project` when the value IS a
 * project decision worth committing.
 *
 * Import weight matters here (Decision 51 / verification-notes §86): this module
 * is pulled in by `golem status` and the status line, so it depends only on the
 * config loader — never on `./init.js` or the hooks barrel.
 */

import { type LayerName, loadConfig, writeSetting } from "../config/index.js";
import {
  type BrevityLevel,
  coerceCompressionLevel,
  compressionName,
} from "../interfaces/policy.js";

export type DialKind = "brevity" | "compression";

/**
 * Accepted values per dial, in display order.
 *
 * R11.1: `auto` is gone from both (it named the retired preset), and
 * `compression` gained `off` — redaction only, which is a real state a user may
 * want and could previously reach only by stopping the proxy. Note what `off`
 * does NOT do: it never disables redaction. That is `proxy.bypass_all`, a
 * separate CLI-only setting, because folding the two into one word is how
 * someone turns off redaction believing they turned off compression (ADR-0004).
 */
export const DIAL_VALUES: Readonly<Record<DialKind, readonly string[]>> = {
  brevity: ["off", "lite", "full", "ultra"],
  compression: ["off", "1", "2", "3"],
};

export const DIAL_SETTING_KEY: Readonly<Record<DialKind, string>> = {
  brevity: "brevity.level",
  compression: "compression.level",
};

/** The effective state of one dial, with enough context to render provenance. */
export interface DialInfo {
  readonly kind: DialKind;
  /** The configured value. */
  readonly setting: string;
  /**
   * The value in force. Equal to `setting` for both dials — R11.1 removed the
   * preset that could make them differ. Kept as its own field because
   * Decision 31's degradation is reported separately (`resolveEffectiveCompression`)
   * and every surface reads this shape.
   */
  readonly effective: string;
  /** The human name for a compression level (`1` → `lossless`); the value itself for brevity. */
  readonly label: string;
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
  const setting = kind === "brevity" ? settings.brevity.level : settings.compression.level;
  const entry = provenance[DIAL_SETTING_KEY[kind]];
  return {
    kind,
    setting,
    effective: setting,
    label:
      kind === "compression" ? compressionName(coerceCompressionLevel(setting)) : String(setting),
    layer: entry?.layer ?? "default",
    ...(entry?.source !== undefined && { source: entry.source }),
  };
}

/**
 * One-line render of a dial's state, shared by every surface so they cannot
 * drift.
 *
 * R11.1 dropped the "(auto — follows slider N)" form. What survives is the
 * distinction between a value someone CHOSE and the shipped default: a fresh
 * install must not look like it has a deliberate override it never got.
 */
export function describeDial(info: DialInfo): string {
  const value = info.kind === "compression" ? `${info.setting} (${info.label})` : info.effective;
  return `${info.kind} ${value}${info.layer === "default" ? " (default)" : ` (set by ${info.layer})`}`;
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
        // R11.1: `0` was the old slider's full bypass. Say where it went rather
        // than letting a muscle-memory `golem compression 0` look like a typo —
        // and be explicit that the replacement turns REDACTION off, which the
        // number never said out loud.
        (kind === "compression" && value === "0"
          ? '\n("0" was the retired slider\'s full bypass, which also disabled REDACTION. ' +
            "Compression-off (redaction still on) is `golem compression off`; the full " +
            "bypass is `golem off`, which persists `proxy.bypass_all` and says so.)"
          : "") +
        (value === "auto"
          ? "\n(`auto` followed the slider preset, which R11.1 retired — set the value you want.)"
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
export function brevityEffectNote(effective: BrevityLevel): string {
  if (effective === "off") return "brevity is OFF — replies are unchanged.";
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

/**
 * Human explanation of what a compression value will do, the counterpart to
 * {@link brevityEffectNote}. R11.1 added it: `off` is newly reachable, and a
 * reader deserves to be told that it is not the same as bypassing Golem.
 */
export function compressionEffectNote(value: string): string {
  switch (value) {
    case "off":
      return (
        "compression is OFF — redaction still runs on every request; nothing else does. " +
        "(To forward requests untouched, redaction included, that is `golem off` — which persists `proxy.bypass_all` until `golem on`.)"
      );
    case "1":
      return "lossless — byte-faithful dedup/compaction. Meaning is preserved exactly.";
    case "2":
      return (
        "balanced — adds lossy semantic compression (stale-turn drop) and a semantic cache. " +
        "Off on a prompt-caching upstream (Decision 31), where it behaves as lossless."
      );
    default:
      return (
        "aggressive — maximum semantic compression. Off on a prompt-caching upstream " +
        "(Decision 31), where it behaves as lossless; needs `compression.headroom_sidecar`."
      );
  }
}
