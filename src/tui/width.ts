/**
 * Display-width arithmetic for terminal text — the job `string-width` and
 * `cli-truncate` did before ink was removed.
 *
 * Two things make `str.length` wrong in a terminal:
 *  - **ANSI escapes** occupy no columns at all;
 *  - some code points occupy **two** columns (CJK, most emoji), and a handful are
 *    *Ambiguous* — single-width in a Western terminal, double in a CJK-configured
 *    one. The pet's leading U+25A0 is one of those (see theme.ts).
 *
 * Ambiguous characters count as **1**, which is what `string-width` did and
 * therefore what the previous ink-based layout already assumed.
 */

import { ESC } from "./ansi.js";

/** Any CSI/OSC escape, for measurement purposes. Built from {@link ESC} so no raw
 * control byte ever appears in this source file. */
const ANY_ESCAPE = new RegExp(
  `${ESC}(?:\\[[0-9;?]*[a-zA-Z]|\\][^${ESC}]*(?:${ESC}\\\\|\\u0007))`,
  "g",
);

/** Strip ANSI escapes, leaving what the terminal actually shows. */
export function stripAnsi(text: string): string {
  return text.replace(ANY_ESCAPE, "");
}

/**
 * Ranges that render two columns wide. Not exhaustive over Unicode — it covers what
 * a project path, a model id, or a settings value realistically contains (CJK,
 * Hangul, kana, fullwidth forms, and the common emoji planes).
 */
const WIDE_RANGES: readonly [number, number][] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols
  [0x3041, 0x33ff], // kana, Hangul compat, CJK compat
  [0x3400, 0x4dbf], // CJK ext A
  [0x4e00, 0x9fff], // CJK unified
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compat ideographs
  [0xfe30, 0xfe6f], // CJK compat forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x1f300, 0x1f64f], // emoji: symbols, pictographs, emoticons
  [0x1f900, 0x1f9ff], // emoji: supplemental
  [0x20000, 0x3fffd], // CJK ext B+
];

function codePointWidth(cp: number): number {
  // Zero-width joiner and combining marks add nothing.
  if (cp === 0x200d || (cp >= 0x300 && cp <= 0x36f)) return 0;
  // Control characters (including a stray ESC) occupy no columns.
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return 0;
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return 2;
  }
  return 1;
}

/** Columns `text` occupies once printed (ANSI-aware, wide-char-aware). */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) {
    width += codePointWidth(char.codePointAt(0) ?? 0);
  }
  return width;
}

/**
 * Truncate to at most `max` columns, ending with `…` when anything was dropped.
 *
 * Escapes pass through rather than being counted, so a truncated coloured string
 * keeps its colour; a reset is appended whenever any escape was seen, so a cut in
 * the middle of a style can't leak colour onto the rest of the line.
 */
export function truncateTo(text: string, max: number): string {
  if (max <= 0) return "";
  if (displayWidth(text) <= max) return text;

  let out = "";
  let width = 0;
  let sawEscape = false;
  for (const part of text.split(SGR_CAPTURE)) {
    if (part === undefined || part === "") continue;
    if (part.startsWith(ESC)) {
      out += part;
      sawEscape = true;
      continue;
    }
    for (const char of part) {
      const w = codePointWidth(char.codePointAt(0) ?? 0);
      // Leave a column for the ellipsis.
      if (width + w > max - 1) return `${out}…${sawEscape ? `${ESC}[0m` : ""}`;
      out += char;
      width += w;
    }
  }
  return `${out}${sawEscape ? `${ESC}[0m` : ""}`;
}

/** SGR sequences, capturing, so `String.split` keeps them as their own parts. */
const SGR_CAPTURE = new RegExp(`(${ESC}\\[[0-9;]*m)`);

/** Pad on the right to exactly `width` columns, truncating when too long. */
export function padTo(text: string, width: number): string {
  const current = displayWidth(text);
  if (current > width) return truncateTo(text, width);
  return text + " ".repeat(width - current);
}
