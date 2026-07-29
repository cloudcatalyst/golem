/**
 * Raw-mode key decoding — what ink's `useInput` did for us.
 *
 * It emits the {@link KeyPress} shape `state.ts` already consumed, which is why the
 * reducer and all 32 of its tests were untouched by removing ink: the decoder was
 * always the only ink-shaped thing in the input path.
 *
 * Follows the pattern already established by `src/credentials/prompt.ts`: raw mode
 * on the TTY, and always restore it — including on Ctrl-C, which must leave the
 * shell usable rather than stuck.
 */

import type { ReadStream } from "node:tty";
import { ESC } from "./ansi.js";
import type { KeyPress } from "./state.js";

const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const RETURN = "\r";
const NEWLINE = "\n";
const TAB = "\t";
/** DEL — what most terminals send for Backspace. */
const BACKSPACE = String.fromCharCode(127);

/**
 * Decode one chunk of raw stdin into zero or more key presses.
 *
 * A chunk can hold several keys (fast typing, or a paste), and an escape sequence
 * can be split across chunks — the caller keeps the remainder. Exported for tests:
 * every sequence this panel cares about is asserted directly.
 */
export function decodeKeys(chunk: string): { keys: KeyPress[]; rest: string } {
  const keys: KeyPress[] = [];
  let i = 0;

  while (i < chunk.length) {
    const ch = chunk[i] ?? "";

    if (ch === ESC) {
      const seq = chunk.slice(i);
      // A lone ESC at the end of a chunk may be the start of a sequence that
      // hasn't arrived yet — hold it back rather than reporting a spurious Escape.
      if (seq.length === 1) return { keys, rest: seq };

      const matched = matchEscape(seq);
      if (matched === null) {
        // Not a sequence we know: treat as the Escape key and move on.
        keys.push({ input: "", escape: true });
        i += 1;
        continue;
      }
      if (matched.incomplete) return { keys, rest: seq };
      keys.push(matched.key);
      i += matched.length;
      continue;
    }

    if (ch === RETURN || ch === NEWLINE) {
      keys.push({ input: "", return: true });
    } else if (ch === TAB) {
      keys.push({ input: "", tab: true });
    } else if (ch === BACKSPACE || ch === "\b") {
      keys.push({ input: "", backspace: true });
    } else if (ch === CTRL_C) {
      keys.push({ input: "c", ctrl: true });
    } else if (ch === CTRL_D) {
      keys.push({ input: "d", ctrl: true });
    } else if (ch < " ") {
      // Other control characters: report as ctrl+<letter> so bindings can use them.
      const code = ch.charCodeAt(0);
      keys.push({ input: String.fromCharCode(code + 96), ctrl: true });
    } else {
      keys.push({ input: ch });
    }
    i += 1;
  }

  return { keys, rest: "" };
}

interface EscapeMatch {
  readonly key: KeyPress;
  /** Characters consumed from the front of the sequence. */
  readonly length: number;
  readonly incomplete?: true;
}

/**
 * CSI sequences the panel binds. Both the `ESC [ A` and the application-cursor
 * `ESC O A` forms are accepted, since terminals differ about which they send.
 */
function matchEscape(seq: string): EscapeMatch | null {
  const second = seq[1];
  if (second !== "[" && second !== "O") return null;
  if (seq.length < 3) return { key: { input: "" }, length: 0, incomplete: true };

  const rest = seq.slice(2);

  // Shift-Tab arrives as CSI Z.
  if (rest.startsWith("Z")) return { key: { input: "", tab: true, shift: true }, length: 3 };
  // Modified arrows: CSI 1 ; <mod> <letter>, e.g. shift-up is CSI 1;2A.
  const modified = /^1;(\d)([ABCD])$/.exec(rest);
  if (modified !== null) {
    const arrow = arrowKey(modified[2] ?? "");
    if (arrow === null) return null;
    const mod = Number(modified[1]);
    return {
      key: { ...arrow, ...(mod === 2 || mod === 6 ? { shift: true } : {}) },
      length: 2 + modified[0].length,
    };
  }
  const plain = rest[0] ?? "";
  const arrow = arrowKey(plain);
  if (arrow !== null) return { key: arrow, length: 3 };
  // Delete is CSI 3 ~.
  if (rest.startsWith("3~")) return { key: { input: "", delete: true }, length: 4 };
  // Home/End/PgUp/PgDn and the rest: consume so they don't leak as text.
  const csi = /^[0-9;]*[~A-Za-z]/.exec(rest);
  if (csi !== null) return { key: { input: "" }, length: 2 + csi[0].length };
  return { key: { input: "" }, length: 0, incomplete: true };
}

function arrowKey(letter: string): KeyPress | null {
  switch (letter) {
    case "A":
      return { input: "", upArrow: true };
    case "B":
      return { input: "", downArrow: true };
    case "C":
      return { input: "", rightArrow: true };
    case "D":
      return { input: "", leftArrow: true };
    default:
      return null;
  }
}

export interface KeyReader {
  /** Restore the terminal exactly as it was found. */
  stop(): void;
}

/**
 * Put the TTY in raw mode and call `onKey` for each decoded press.
 *
 * Raw mode is what makes single-keypress navigation possible (no Enter needed); it
 * also means WE are responsible for Ctrl-C, which the panel's reducer turns into an
 * exit. {@link KeyReader.stop} must be called on every exit path — the caller wraps
 * it in a `finally`.
 */
export function readKeys(
  onKey: (key: KeyPress) => void,
  input: ReadStream = process.stdin as ReadStream,
): KeyReader {
  let pending = "";
  const onData = (chunk: string): void => {
    const { keys, rest } = decodeKeys(pending + chunk);
    pending = rest;
    for (const key of keys) onKey(key);
  };

  const wasRaw = input.isRaw === true;
  if (input.isTTY) input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  input.on("data", onData);

  return {
    stop(): void {
      input.removeListener("data", onData);
      if (input.isTTY) input.setRawMode(wasRaw);
      input.pause();
    },
  };
}
