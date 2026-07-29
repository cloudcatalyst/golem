/**
 * The raw-mode key decoder that replaced ink's `useInput`.
 *
 * This is the one piece of the ink removal with real protocol subtlety — escape
 * sequences arrive split across reads, terminals disagree about which form they
 * send, and anything mis-decoded either does the wrong thing or leaks control
 * characters into a text field. So every sequence the panel binds is asserted here.
 */

import { describe, expect, it } from "vitest";
import { ESC } from "../../src/tui/ansi.js";
import { decodeKeys } from "../../src/tui/keys.js";

const only = (chunk: string) => {
  const { keys, rest } = decodeKeys(chunk);
  expect(rest, `unexpected remainder for ${JSON.stringify(chunk)}`).toBe("");
  expect(keys, `expected exactly one key for ${JSON.stringify(chunk)}`).toHaveLength(1);
  return keys[0];
};

describe("printable input", () => {
  it("passes letters, digits, and punctuation through", () => {
    for (const ch of ["a", "Z", "7", "?", " ", "["]) {
      expect(only(ch)).toEqual({ input: ch });
    }
  });

  it("splits a multi-character chunk into separate presses", () => {
    const { keys } = decodeKeys("abc");
    expect(keys).toEqual([{ input: "a" }, { input: "b" }, { input: "c" }]);
  });

  it("keeps non-ASCII text intact", () => {
    expect(only("é")).toEqual({ input: "é" });
  });
});

describe("named keys", () => {
  it("decodes return, tab, and backspace", () => {
    expect(only("\r")).toEqual({ input: "", return: true });
    expect(only("\n")).toEqual({ input: "", return: true });
    expect(only("\t")).toEqual({ input: "", tab: true });
    expect(only(String.fromCharCode(127))).toEqual({ input: "", backspace: true });
    expect(only("\b")).toEqual({ input: "", backspace: true });
  });

  it("decodes Ctrl-C and Ctrl-D, which the reducer turns into an exit", () => {
    expect(only(String.fromCharCode(3))).toEqual({ input: "c", ctrl: true });
    expect(only(String.fromCharCode(4))).toEqual({ input: "d", ctrl: true });
  });

  it("reports other control characters as ctrl+letter", () => {
    // Ctrl-A .. Ctrl-Z map onto 1..26.
    expect(only(String.fromCharCode(1))).toEqual({ input: "a", ctrl: true });
    expect(only(String.fromCharCode(12))).toEqual({ input: "l", ctrl: true });
  });
});

describe("escape sequences", () => {
  it("decodes the four arrows in CSI form", () => {
    expect(only(`${ESC}[A`)).toEqual({ input: "", upArrow: true });
    expect(only(`${ESC}[B`)).toEqual({ input: "", downArrow: true });
    expect(only(`${ESC}[C`)).toEqual({ input: "", rightArrow: true });
    expect(only(`${ESC}[D`)).toEqual({ input: "", leftArrow: true });
  });

  it("also accepts the application-cursor form terminals sometimes send", () => {
    expect(only(`${ESC}OA`)).toEqual({ input: "", upArrow: true });
    expect(only(`${ESC}OD`)).toEqual({ input: "", leftArrow: true });
  });

  it("decodes Shift-Tab, which steps the tab bar backwards", () => {
    expect(only(`${ESC}[Z`)).toEqual({ input: "", tab: true, shift: true });
  });

  it("decodes a modified arrow without losing the arrow", () => {
    expect(only(`${ESC}[1;2A`)).toEqual({ input: "", upArrow: true, shift: true });
  });

  it("decodes Delete", () => {
    expect(only(`${ESC}[3~`)).toEqual({ input: "", delete: true });
  });

  it("treats a bare Escape as the Escape key", () => {
    const { keys } = decodeKeys(`${ESC}x`);
    expect(keys[0]).toEqual({ input: "", escape: true });
  });

  it("swallows sequences it doesn't bind, rather than leaking them as text", () => {
    // Home/End/PgUp — must not end up inside a value being typed.
    for (const seq of [`${ESC}[H`, `${ESC}[F`, `${ESC}[5~`, `${ESC}[200~`]) {
      const { keys, rest } = decodeKeys(seq);
      expect(rest).toBe("");
      expect(keys).toEqual([{ input: "" }]);
    }
  });
});

describe("chunk boundaries", () => {
  it("holds back a lone trailing ESC until the rest arrives", () => {
    const first = decodeKeys(ESC);
    expect(first.keys).toEqual([]);
    expect(first.rest).toBe(ESC);
    // The caller prepends the remainder to the next chunk.
    expect(decodeKeys(`${first.rest}[A`).keys).toEqual([{ input: "", upArrow: true }]);
  });

  it("holds back a partially-arrived sequence", () => {
    const partial = decodeKeys(`${ESC}[`);
    expect(partial.keys).toEqual([]);
    expect(partial.rest).toBe(`${ESC}[`);
    expect(decodeKeys(`${partial.rest}B`).keys).toEqual([{ input: "", downArrow: true }]);
  });

  it("emits keys before a partial sequence, keeping only the tail", () => {
    const { keys, rest } = decodeKeys(`ab${ESC}[`);
    expect(keys).toEqual([{ input: "a" }, { input: "b" }]);
    expect(rest).toBe(`${ESC}[`);
  });

  it("decodes several sequences in one chunk (a fast paste or key repeat)", () => {
    const { keys, rest } = decodeKeys(`${ESC}[A${ESC}[Bx\r`);
    expect(rest).toBe("");
    expect(keys).toEqual([
      { input: "", upArrow: true },
      { input: "", downArrow: true },
      { input: "x" },
      { input: "", return: true },
    ]);
  });

  it("returns nothing for an empty chunk", () => {
    expect(decodeKeys("")).toEqual({ keys: [], rest: "" });
  });
});
