/**
 * Colours and glyphs for the `golem ui` panel.
 *
 * Colour handling is deliberately thin. ink renders through chalk, which already
 * downgrades a 24-bit hex to 256 or 16 colours based on what the terminal
 * advertises, and honours `NO_COLOR` / `FORCE_COLOR`. So the `ui.color` policy is
 * applied at that level too — {@link applyColorPolicy} sets `FORCE_COLOR` before
 * ink is imported — rather than by threading "maybe no colour" through every
 * component. That keeps every {@link Theme} field a real colour string, which
 * matters under `exactOptionalPropertyTypes`: ink's `<Text color>` does not accept
 * an explicit `undefined`.
 *
 * Where a colour is genuinely optional (an untoned header segment, an unselected
 * row), use {@link col} to spread the prop in or leave it out.
 */

import type { UiSettings } from "../config/index.js";

export interface Theme {
  readonly pet: string;
  readonly accent: string;
  readonly dim: string;
  readonly ok: string;
  readonly warn: string;
  readonly error: string;
}

/** Violet, matching the pet's default. */
const ACCENT = "#a78bfa";

export function themeFor(ui: UiSettings): Theme {
  return {
    pet: ui.pet_color,
    accent: ACCENT,
    dim: "gray",
    ok: "green",
    warn: "yellow",
    error: "red",
  };
}

/**
 * Apply `ui.color` to the environment chalk reads at import time. MUST be called
 * before ink is imported, and only affects this process.
 *
 * `never` forces colour off entirely; `always` forces it on even when the output
 * isn't a terminal; `auto` leaves detection (and any `NO_COLOR` the user set)
 * exactly as it was.
 */
export function applyColorPolicy(
  policy: UiSettings["color"],
  env: Record<string, string | undefined> = process.env,
): void {
  if (policy === "never") env.FORCE_COLOR = "0";
  else if (policy === "always" && env.FORCE_COLOR === undefined) env.FORCE_COLOR = "1";
}

/**
 * Spread into an ink element so an absent colour omits the prop rather than
 * passing `undefined` (which `exactOptionalPropertyTypes` rejects):
 * `<Text {...col(selected ? theme.accent : undefined)}>`.
 */
export function col(value: string | undefined): { color?: string } {
  return value === undefined ? {} : { color: value };
}

/**
 * The Golem pet: three rows of eight Unicode block-element glyphs.
 *
 * Kept as a plain constant so tests can assert on it. NOTE the first glyph is
 * U+25A0 BLACK SQUARE, whose East Asian Width is *Ambiguous* — single-width in
 * most terminals, double-width in a CJK-configured one. Callers must draw the pet
 * inside a fixed-width box ({@link PET_WIDTH} plus padding) so a double-wide
 * render can shift that glyph without pushing the header text out of alignment.
 */
export const PET_LINES: readonly string[] = ["■▜▛▜▆▛▜▙", "▝▜██▀███", "▚▟█▛▚█▛▘"];

/** Column count the pet is laid out in (glyph count; see the width caveat above). */
export const PET_WIDTH = 8;

/** Horizontal rule glyph. */
export const RULE_CHAR = "─";
