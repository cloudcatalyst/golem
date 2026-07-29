/**
 * Colours and glyphs for the `golem` control panel.
 *
 * Every colour is a **hex triplet**; `ansi.ts` degrades it to whatever the terminal
 * advertises (24-bit → 256 → 16 → none). That replaced chalk when ink was removed,
 * and it means the theme has no notion of "no colour" — a colourless terminal is
 * expressed as {@link Theme.level} 0, so callers never have to branch.
 */

import type { UiSettings } from "../config/index.js";
import { type ColorLevel, detectColorLevel } from "./ansi.js";

export interface Theme {
  readonly pet: string;
  readonly accent: string;
  readonly dim: string;
  readonly ok: string;
  readonly warn: string;
  readonly error: string;
  /** How much colour to actually emit; 0 means the panel renders as plain text. */
  readonly level: ColorLevel;
}

/** Violet, matching the pet's default. */
const ACCENT = "#a78bfa";

/**
 * Build the theme for the effective `ui` settings.
 *
 * `ui.color` is applied here rather than by poking `FORCE_COLOR` into the
 * environment (which is what the ink/chalk version had to do): `never` forces
 * level 0, `always` forces at least the basic 16 when detection says none, and
 * `auto` takes detection as-is — which already honours `NO_COLOR`/`FORCE_COLOR`.
 */
export function themeFor(
  ui: UiSettings,
  env: Readonly<Record<string, string | undefined>> = process.env,
  isTty: boolean = process.stdout.isTTY === true,
): Theme {
  const detected = detectColorLevel(env, isTty);
  const level: ColorLevel =
    ui.color === "never" ? 0 : ui.color === "always" && detected === 0 ? 1 : detected;
  return {
    pet: ui.pet_color,
    accent: ACCENT,
    dim: "#8a8a8a",
    ok: "#3fb950",
    warn: "#d7ba7d",
    error: "#f85149",
    level,
  };
}

/**
 * The Golem pet: three rows of eight Unicode block-element glyphs.
 *
 * NOTE the first glyph is U+25A0 BLACK SQUARE, whose East Asian Width is
 * **Ambiguous** — single-width in most terminals, double-width in a CJK-configured
 * one. The pet is drawn in a fixed-width column ({@link PET_WIDTH} plus padding), so
 * a double-wide render can shift that glyph without pushing the header text out of
 * alignment. `ui.pet false` / `golem --no-pet` turns it off, which is also the
 * escape hatch for legacy Windows consoles that can't draw block elements.
 */
export const PET_LINES: readonly string[] = ["■▜▛▜▆▛▜▙", "▝▜██▀███", "▚▟█▛▚█▛▘"];

/** Columns the pet is laid out in (glyph count; see the width caveat above). */
export const PET_WIDTH = 8;

/** Horizontal rule glyph. */
export const RULE_CHAR = "─";
