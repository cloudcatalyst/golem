/**
 * The only module that owns the ESC byte, plus the escape sequences and colour
 * handling the panel needs. This is what replaced `chalk` when ink was removed.
 *
 * ESC is built with `String.fromCharCode(27)` rather than written literally: a raw
 * control character in source is invisible in diffs and is silently mangled by
 * ordinary text tooling.
 *
 * Colour support is detected once, the way chalk does it, and every colour in the
 * theme is a hex triplet that gets degraded to whatever the terminal advertises:
 * 24-bit → 256-colour cube → the basic 16 → nothing at all.
 */

export const ESC = String.fromCharCode(27);
/** Control Sequence Introducer. */
export const CSI = `${ESC}[`;

// --- sequences --------------------------------------------------------------

export const RESET = `${CSI}0m`;
export const BOLD = `${CSI}1m`;
export const DIM = `${CSI}2m`;
export const CLEAR_TO_END = `${CSI}0J`;
export const CLEAR_LINE = `${CSI}2K`;
export const HIDE_CURSOR = `${CSI}?25l`;
export const SHOW_CURSOR = `${CSI}?25h`;
/** Home the cursor without clearing — the panel repaints in place. */
export const CURSOR_HOME = `${CSI}H`;

export const cursorTo = (row: number, col = 1): string => `${CSI}${row};${col}H`;

// --- colour -----------------------------------------------------------------

/** How much colour the terminal can show. */
export type ColorLevel = 0 | 1 | 2 | 3; // none | 16 | 256 | 24-bit

/**
 * Detect colour support from the environment, mirroring chalk's precedence:
 * `NO_COLOR` and `FORCE_COLOR` win over everything, then a non-TTY means no
 * colour, then `COLORTERM`/`TERM`/Windows Terminal decide the depth.
 */
export function detectColorLevel(
  env: Readonly<Record<string, string | undefined>> = process.env,
  isTty: boolean = process.stdout.isTTY === true,
): ColorLevel {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return 0;
  const forced = env.FORCE_COLOR;
  if (forced !== undefined) {
    if (forced === "0" || forced === "false") return 0;
    if (forced === "1" || forced === "true" || forced === "") return 1;
    if (forced === "2") return 2;
    if (forced === "3") return 3;
  }
  if (!isTty) return 0;
  // Windows Terminal, VS Code's terminal, and modern iTerm all do 24-bit.
  if (env.WT_SESSION !== undefined || env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") {
    return 3;
  }
  if (env.TERM_PROGRAM === "vscode" || env.TERM_PROGRAM === "iTerm.app") return 3;
  const term = env.TERM ?? "";
  if (term === "dumb") return 0;
  if (term.includes("256")) return 2;
  if (term !== "" || env.OS === "Windows_NT") return 1;
  return 1;
}

/** `#rrggbb` / `#rgb` → [r, g, b]; null when unparseable. */
function parseHex(hex: string): [number, number, number] | null {
  const raw = hex.startsWith("#") ? hex.slice(1) : hex;
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  if (full.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/** Nearest xterm-256 index for an RGB triplet (6x6x6 cube, or the grey ramp). */
function to256(r: number, g: number, b: number): number {
  // Greys have their own ramp and look much better on it than in the cube.
  if (Math.abs(r - g) < 12 && Math.abs(g - b) < 12) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.round(((r - 8) / 247) * 24);
  }
  const q = (v: number) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

/** Nearest of the basic 16 (30–37 / 90–97) for an RGB triplet. */
function to16(r: number, g: number, b: number): number {
  const bright = Math.max(r, g, b) > 170;
  const bit = (v: number) => (v > 110 ? 1 : 0);
  const code = 30 + (bit(r) | (bit(g) << 1) | (bit(b) << 2));
  return bright ? code + 60 : code;
}

/** The SGR foreground sequence for a hex colour at a given level ("" for none). */
export function fg(hex: string, level: ColorLevel): string {
  if (level === 0) return "";
  const rgb = parseHex(hex);
  if (rgb === null) return "";
  const [r, g, b] = rgb;
  if (level === 3) return `${CSI}38;2;${r};${g};${b}m`;
  if (level === 2) return `${CSI}38;5;${to256(r, g, b)}m`;
  return `${CSI}${to16(r, g, b)}m`;
}

/**
 * Wrap `text` in a colour (and optionally bold), or return it untouched when the
 * terminal can't colour. Never leaves a style unclosed.
 */
export function paint(
  text: string,
  hex: string | undefined,
  level: ColorLevel,
  opts: { readonly bold?: boolean } = {},
): string {
  if (level === 0 || (hex === undefined && opts.bold !== true)) return text;
  const colour = hex !== undefined ? fg(hex, level) : "";
  const prefix = `${opts.bold === true ? BOLD : ""}${colour}`;
  return prefix === "" ? text : `${prefix}${text}${RESET}`;
}
