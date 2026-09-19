/**
 * The braille quota meter — two bars in one row of characters.
 *
 * The golden cases below are the ones the encoding was specified against, so
 * they are written as literal braille rather than as dot masks: if a future
 * change moves the session bar off dots 2 and 5, these fail with a diff a
 * human can read at a glance.
 */

import { describe, expect, it } from "vitest";
import {
  QUOTA_BAR_CELLS,
  QUOTA_CAP_END,
  QUOTA_CAP_START,
  quotaBar,
  quotaSeverity,
  quotaUnits,
  renderQuotaSegment,
} from "../../../src/cli/quota-bars.js";

/** Blank braille cell — what unused quota renders as. */
const BLANK = "⠀";

/** Drive the bar in whole UNITS, which is how the encoding is specified. */
function bar(sessionUnits: number, weeklyUnits: number, cells: number): string {
  const total = cells * 2;
  return quotaBar((sessionUnits / total) * 100, (weeklyUnits / total) * 100, cells);
}

/** A palette that paints nothing, so tests can assert on glyphs alone. */
const plain = {
  accent: (s: string) => s,
  warn: (s: string) => s,
  critical: (s: string) => s,
};

describe("quota bars: the specified encoding", () => {
  it("renders the four golden cases exactly", () => {
    // Dot-row 1 (the very top) is a permanent margin, never touched. Session
    // sits on dot-row 2, dot-row 3 is a one-row gap, and weekly sits on
    // dot-row 4 (the very bottom) — so the bottom THREE dot-rows carry the
    // meter and the top row is always blank. Earlier sets tried for these same
    // four cases: rows 1/3 with no top margin (⠉⠉⠁ / ⠭⠭⠍ / ⠭⠭⠥ / ⠤⠤⠄), rows
    // 1-2 / 3-4 with no gap at all (⠛⠛⠃ / ⣿⣿⡟ / ⣿⣿⣧ / ⣤⣤⡄, tried twice),
    // quadrant blocks (▀▀▘ / ██▛ / ██▙ / ▄▄▖, too thick), and rows 1/4 with a
    // two-row gap but no top margin (⠉⠉⠁ / ⣉⣉⡉ / ⣉⣉⣁ / ⣀⣀⡀).
    expect(bar(5, 0, 3)).toBe("⠒⠒⠂");
    expect(bar(6, 5, 3)).toBe("⣒⣒⡒");
    expect(bar(5, 6, 3)).toBe("⣒⣒⣂");
    expect(bar(0, 5, 3)).toBe("⣀⣀⡀");
  });

  it("leaves row 1 (top margin) and row 3 (the gap) empty", () => {
    // Dots 1, 4, 3 and 6 are 0x01, 0x08, 0x04 and 0x20.
    for (const ch of bar(4, 3, 5)) {
      const mask = (ch.codePointAt(0) as number) - 0x2800;
      expect(mask & (0x01 | 0x08 | 0x04 | 0x20)).toBe(0);
    }
  });

  it("fills left-to-right, half a cell at a time", () => {
    expect(bar(1, 0, 2)).toBe(`⠂${BLANK}`);
    expect(bar(2, 0, 2)).toBe(`⠒${BLANK}`);
    expect(bar(3, 0, 2)).toBe("⠒⠂");
    expect(bar(4, 0, 2)).toBe("⠒⠒");
  });

  it("draws an empty meter as blank cells, not as a shorter string", () => {
    expect(bar(0, 0, 4)).toBe(BLANK.repeat(4));
  });

  it("draws a full meter as thin rows 2-and-4, not solid cells", () => {
    expect(quotaBar(100, 100, 4)).toBe("⣒⣒⣒⣒");
  });

  it("keeps the meter the same width however full it is", () => {
    // The line redraws every 2s; a bar that changes width would jitter.
    for (const pct of [0, 1, 17, 50, 83, 99, 100]) {
      expect([...quotaBar(pct, 100 - pct)].length).toBe(QUOTA_BAR_CELLS);
    }
  });
});

describe("quota bars: percentage to units", () => {
  it("maps the ends exactly", () => {
    expect(quotaUnits(0, 20)).toBe(0);
    expect(quotaUnits(100, 20)).toBe(20);
    expect(quotaUnits(150, 20)).toBe(20);
  });

  it("shows a touched quota as at least one unit", () => {
    // Rounding 2% to nothing would claim the window is untouched when it isn't.
    expect(quotaUnits(2, 20)).toBe(1);
    expect(quotaUnits(0.4, 20)).toBe(1);
  });

  it("treats absent and non-finite readings as empty, not as zero usage drawn", () => {
    expect(quotaUnits(undefined, 20)).toBe(0);
    expect(quotaUnits(Number.NaN, 20)).toBe(0);
    expect(quotaUnits(-5, 20)).toBe(0);
  });
});

describe("quota bars: severity", () => {
  it("is driven by whichever window is fuller", () => {
    expect(quotaSeverity(10, 10)).toBe("normal");
    expect(quotaSeverity(80, 10)).toBe("warn");
    expect(quotaSeverity(10, 80)).toBe("warn");
    expect(quotaSeverity(95, 10)).toBe("critical");
    expect(quotaSeverity(10, 95)).toBe("critical");
  });

  it("ignores a missing window rather than reading it as full", () => {
    expect(quotaSeverity(10, undefined)).toBe("normal");
    expect(quotaSeverity(undefined, undefined)).toBe("normal");
  });
});

describe("quota bars: the status-line segment", () => {
  it("renders nothing at all when neither window was reported", () => {
    // A cold rate-limit feed must not render as a confident empty meter.
    expect(renderQuotaSegment(undefined, undefined, plain)).toBe("");
  });

  it("renders when only one window is known", () => {
    expect(renderQuotaSegment(50, undefined, plain)).not.toBe("");
  });

  it("wraps the bar in caps", () => {
    const seg = renderQuotaSegment(50, 25, plain);
    expect(seg.startsWith(QUOTA_CAP_START)).toBe(true);
    expect(seg.endsWith(QUOTA_CAP_END)).toBe(true);
    expect([...seg].length).toBe(QUOTA_BAR_CELLS + 2);
  });

  it("paints caps and bar the SAME severity colour — one meter, not two widgets", () => {
    const tagged = {
      accent: (s: string) => `<accent>${s}</accent>`,
      warn: (s: string) => `<warn>${s}</warn>`,
      critical: (s: string) => `<critical>${s}</critical>`,
    };
    expect(renderQuotaSegment(10, 10, tagged)).toBe(
      `<accent>${QUOTA_CAP_START}${quotaBar(10, 10)}${QUOTA_CAP_END}</accent>`,
    );
    expect(renderQuotaSegment(80, 10, tagged)).toContain("<warn>");
    expect(renderQuotaSegment(95, 10, tagged)).toContain("<critical>");
    // Neither cap gets a colour of its own — no dim/plain wrapper split out.
    expect(renderQuotaSegment(10, 10, tagged)).not.toContain("<dim>");
  });

  it("paints the whole segment — both caps and the bar — as ONE span", () => {
    const esc = String.fromCharCode(27);
    const span = (code: number) => (s: string) => `${esc}[${code}m${s}${esc}[0m`;
    const seg = renderQuotaSegment(40, 20, {
      accent: span(97), // bright white
      warn: span(33),
      critical: span(31),
    });
    expect(seg).toBe(`${esc}[97m${QUOTA_CAP_START}${quotaBar(40, 20)}${QUOTA_CAP_END}${esc}[0m`);
    // Exactly one reset for the entire segment — no stray resets mid-string.
    expect(seg.match(new RegExp(`${esc}\\[0m`, "g"))?.length).toBe(1);
  });

  it("renders as plain text with no escape bytes when the terminal has no colour", () => {
    const seg = renderQuotaSegment(40, 20, plain);
    expect(seg).not.toContain(String.fromCharCode(27));
    expect([...seg].length).toBe(QUOTA_BAR_CELLS + 2);
  });

  it("uses ONE colour span, because unused quota is absence of ink", () => {
    // The whole point of the blank-cell encoding: two bars of different lengths
    // inside a single colour run, which is all a terminal cell can hold.
    const mark = (s: string) => `[${s}]`;
    const counted = { accent: mark, warn: mark, critical: mark };
    for (const [session, weekly] of [
      [90, 20],
      [20, 90],
      [40, 5],
    ]) {
      const seg = renderQuotaSegment(session, weekly, counted);
      expect(seg.match(/\[/g)?.length).toBe(1);
    }
  });
});
