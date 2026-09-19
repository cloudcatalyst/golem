/**
 * The braille quota meter for `golem statusline`.
 *
 * `statusline.ts` has parsed Claude Code's `fiveHourPct` / `sevenDayPct` since
 * WS-E but deliberately did not render them: the note at
 * {@link renderStatusLine} parked them on 2026-07-24 pending "a legible
 * one-liner treatment". This is that treatment.
 *
 * A braille cell is a 2x4 dot matrix, so ONE character carries two independent
 * horizontal bars one dot-row tall each. Dot-row 1 — the very TOP — is always
 * empty; the session window takes dot-row 2, dot-row 3 is always empty as the
 * gap, and the weekly window takes dot-row 4, the very bottom:
 *
 * ```
 *   dot 1  dot 4   (always empty: top margin)
 *   dot 2  dot 5   session (5h)
 *   dot 3  dot 6   (always empty: the gap)
 *   dot 7  dot 8   weekly (7d)
 * ```
 *
 * So `⠒⠒⠂` is session 5 units / weekly 0, `⣒⣒⡒` is session 6 / weekly 5,
 * `⣒⣒⣂` is session 5 / weekly 6, and `⣀⣀⡀` is session 0 / weekly 5. Each bar
 * stays a single thin dot-row — never doubled to `⣿`-style fill.
 *
 * **Other character sets tried.** The original spec used dot-rows 1 and 3, top
 * margin none, gap one row (`⠉⠉⠁`, `⠭⠭⠍`, `⠭⠭⠥`, `⠤⠤⠄`). Doubling each bar to
 * two dot-rows with no gap at all (`⠛⠛⠃`, `⣿⣿⡟`, `⣿⣿⣧`, `⣤⣤⡄`) was tried twice
 * and made the bars heavier without reading as more separated. Quadrant
 * blocks (`▀▀▘`, `██▛`, `██▙`, `▄▄▖`) fixed the weight but were too thick.
 * Pushing the bars to the cell's opposite edges — dot-row 1 (session) and
 * dot-row 4 (weekly), both middle rows empty (`⠉⠉⠁`, `⣉⣉⡉`, `⣉⣉⣁`, `⣀⣀⡀`) —
 * widened the gap to two rows but put session flush against the top of the
 * line, with nothing above it. This form keeps that two-row separation (one
 * gap row plus one margin row) but moves the WHOLE pattern down by a row, so
 * the margin sits above the bars instead of the bars sitting flush at the top
 * — the bottom three dot-rows carry the meter, the top row is never touched.
 *
 * **Why this encoding survives the one-colour-per-character constraint.** A
 * terminal cell takes a single colour, and the two bars are almost never the
 * same length — so a cell can hold session ink and no weekly ink. Unused quota
 * is therefore drawn as *absence of ink* (a blank braille cell) rather than as a
 * differently-coloured glyph: colouring a blank is a no-op, which means the
 * whole bar can be emitted inside ONE colour span and still show two bars of
 * different lengths. The end caps mark 0% and 100% so a short bar is legible
 * as "little used" rather than as a truncated line — and they paint in the
 * SAME colour as the bar (not a separate dim tone), so the whole meter reads
 * as one bright unit rather than a bar between two dark ticks.
 */

/** `U+2800 BRAILLE PATTERN BLANK` — every pattern is this plus a dot bitmask. */
const BRAILLE_BASE = 0x2800;

// Dot -> bit. The Unicode braille block orders the low six bits down the left
// column then down the right, and puts dots 7/8 in the top two bits, which is
// why none of these are contiguous. Dots 1 and 4 (row 1, the top) are never
// referenced by anything below — that row is the permanent top margin.
/** Dot 2 — session bar, left half of the cell (row 2). */
const SESSION_LEFT = 0x02;
/** Dot 5 — session bar, right half of the cell (row 2). */
const SESSION_RIGHT = 0x10;
/** Dot 7 — weekly bar, left half of the cell (row 4, the bottom). */
const WEEKLY_LEFT = 0x40;
/** Dot 8 — weekly bar, right half of the cell (row 4, the bottom). */
const WEEKLY_RIGHT = 0x80;

/**
 * Unused quota is a BLANK BRAILLE CELL, not a space.
 *
 * Both are invisible, but they are not interchangeable here: in a font that
 * renders braille wider than a space, a space-padded bar changes total width as
 * it fills, and this line redraws every 2s (`statusLine.refreshInterval`). Same
 * character class in, same advance width out — the meter never jitters.
 */
const UNUSED_CELL = String.fromCodePoint(BRAILLE_BASE);

// Bottom-THREE-rows rules, matching the bar's own height now that the top
// row is a permanent margin rather than part of the meter — a full four-row
// cap beside a three-row bar would stand taller than the thing it brackets.
// LEFT column at the START (0% end), RIGHT column at the END (100% end).
/** Dots 2-3-7: a rule up the LEFT edge, rows 2-4, at the bar's 0% end. */
export const QUOTA_CAP_START = "⡆";
/** Dots 5-6-8: a rule up the RIGHT edge, rows 2-4, at the bar's 100% end. */
export const QUOTA_CAP_END = "⢰";

/** Each cell is two dots wide, so it carries two units of bar per row. */
const UNITS_PER_CELL = 2;

/**
 * Bar width in cells. Ten cells is twenty units, i.e. one unit per 5% — a round
 * enough mapping to read a percentage off the bar, and twelve columns of status
 * line once the caps are counted.
 */
export const QUOTA_BAR_CELLS = 10;

/** How much of the bar a percentage fills, in units (0 .. `totalUnits`). */
export function quotaUnits(pct: number | undefined, totalUnits: number): number {
  if (pct === undefined || !Number.isFinite(pct) || pct <= 0) return 0;
  if (pct >= 100) return totalUnits;
  // Floor at one unit: a quota that has been touched at all must not render
  // identically to one that has not. Rounding 2% to nothing is the version of
  // this line that says "you have used none of your week" while you have.
  return Math.min(totalUnits, Math.max(1, Math.round((pct / 100) * totalUnits)));
}

/**
 * The bar itself — `cells` characters, no caps and no colour.
 *
 * @param sessionPct percentage of the session (5h) window used
 * @param weeklyPct percentage of the weekly (7d) window used
 */
export function quotaBar(
  sessionPct: number | undefined,
  weeklyPct: number | undefined,
  cells: number = QUOTA_BAR_CELLS,
): string {
  const totalUnits = cells * UNITS_PER_CELL;
  const session = quotaUnits(sessionPct, totalUnits);
  const weekly = quotaUnits(weeklyPct, totalUnits);

  let out = "";
  for (let cell = 0; cell < cells; cell += 1) {
    // Unit indices this cell covers; a unit is filled when the bar runs PAST it.
    const left = cell * UNITS_PER_CELL;
    const right = left + 1;
    let mask = 0;
    if (session > left) mask |= SESSION_LEFT;
    if (session > right) mask |= SESSION_RIGHT;
    if (weekly > left) mask |= WEEKLY_LEFT;
    if (weekly > right) mask |= WEEKLY_RIGHT;
    out += mask === 0 ? UNUSED_CELL : String.fromCodePoint(BRAILLE_BASE + mask);
  }
  return out;
}

/** How alarming the fuller of the two windows is. */
export type QuotaSeverity = "normal" | "warn" | "critical";

/** Percentage at which the meter stops being decorative. */
const WARN_PCT = 75;
/** Percentage at which the meter is the most useful thing on the line. */
const CRITICAL_PCT = 90;

/**
 * Severity is driven by whichever window is fuller, because both bars share a
 * colour: the cells cannot disagree, so the meter reports the nearer limit.
 */
export function quotaSeverity(
  sessionPct: number | undefined,
  weeklyPct: number | undefined,
): QuotaSeverity {
  const worst = Math.max(
    Number.isFinite(sessionPct) ? (sessionPct as number) : 0,
    Number.isFinite(weeklyPct) ? (weeklyPct as number) : 0,
  );
  if (worst >= CRITICAL_PCT) return "critical";
  if (worst >= WARN_PCT) return "warn";
  return "normal";
}

/**
 * The colours the segment paints with, supplied by the caller's ANSI helpers.
 *
 * No `dim` field: the caps used to paint separately from the bar, but a start
 * and end tick in a different tone from the thing they bracket reads as two
 * widgets, not one meter. All three tiers below paint bar AND caps alike.
 */
export interface QuotaPalette {
  readonly accent: (s: string) => string;
  readonly warn: (s: string) => string;
  readonly critical: (s: string) => string;
}

/**
 * The finished segment: start cap, the bar, end cap, all in one severity
 * colour. Empty string when Claude Code reported neither window — an absent
 * rate-limit feed must render as nothing, never as a confident empty meter,
 * which is the same honesty the snooze gate applies when its feed goes cold.
 */
export function renderQuotaSegment(
  sessionPct: number | undefined,
  weeklyPct: number | undefined,
  palette: QuotaPalette,
  cells: number = QUOTA_BAR_CELLS,
): string {
  const haveSession = sessionPct !== undefined && Number.isFinite(sessionPct);
  const haveWeekly = weeklyPct !== undefined && Number.isFinite(weeklyPct);
  if (!haveSession && !haveWeekly) return "";

  const severity = quotaSeverity(sessionPct, weeklyPct);
  const ink =
    severity === "critical"
      ? palette.critical
      : severity === "warn"
        ? palette.warn
        : palette.accent;

  return ink(`${QUOTA_CAP_START}${quotaBar(sessionPct, weeklyPct, cells)}${QUOTA_CAP_END}`);
}
