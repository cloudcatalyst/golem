/**
 * The screen writer — what ink's renderer did: put frames on the terminal without
 * flicker, and always leave the terminal as it was found.
 *
 * Two things make this safe to hand-roll for this panel:
 *  - it draws a **full-screen** frame, so there is no scroll-region bookkeeping;
 *  - frames are line arrays, so "don't flicker" reduces to "only rewrite the lines
 *    that changed", which is a string comparison.
 *
 * The alternate screen buffer is deliberately NOT used. Staying in the normal buffer
 * means the panel's last frame remains visible in scrollback after quitting, which
 * matches how `golem status` behaves and is friendlier when someone is reading a
 * value off the screen. The cost is that we clear our own lines on exit.
 */

import {
  CLEAR_LINE,
  CLEAR_TO_END,
  CURSOR_HOME,
  cursorTo,
  HIDE_CURSOR,
  RESET,
  SHOW_CURSOR,
} from "./ansi.js";

export interface ScreenOptions {
  readonly out?: NodeJS.WriteStream;
  /** Called when the terminal is resized, so the caller can repaint. */
  readonly onResize?: () => void;
}

export interface Screen {
  readonly columns: number;
  readonly rows: number;
  /** Draw a frame, rewriting only the lines that differ from the last one. */
  paint(lines: readonly string[]): void;
  /** Restore the cursor and leave the final frame in place. */
  close(): void;
}

export function createScreen(options: ScreenOptions = {}): Screen {
  const out = options.out ?? process.stdout;
  let previous: readonly string[] = [];
  let closed = false;

  const onResize = (): void => {
    // A resize invalidates every line, so force a full repaint next time.
    previous = [];
    options.onResize?.();
  };
  out.on("resize", onResize);
  out.write(HIDE_CURSOR);

  return {
    get columns(): number {
      return out.columns ?? 80;
    },
    get rows(): number {
      return out.rows ?? 24;
    },

    paint(lines: readonly string[]): void {
      if (closed) return;
      const parts: string[] = [];
      // Absolute positioning per changed line: cheaper than redrawing the frame,
      // and immune to the cursor being left anywhere in particular.
      const height = Math.max(lines.length, previous.length);
      for (let i = 0; i < height; i += 1) {
        const next = lines[i];
        if (next === previous[i]) continue;
        parts.push(cursorTo(i + 1, 1));
        parts.push(CLEAR_LINE);
        if (next !== undefined) parts.push(next);
      }
      // The frame shrank: clear whatever the old, taller frame left below it.
      if (lines.length < previous.length) {
        parts.push(cursorTo(lines.length + 1, 1));
        parts.push(CLEAR_TO_END);
      }
      if (parts.length > 0) out.write(parts.join(""));
      previous = [...lines];
    },

    close(): void {
      if (closed) return;
      closed = true;
      out.removeListener("resize", onResize);
      // Park the cursor just below the frame so the shell prompt lands cleanly.
      out.write(`${cursorTo(previous.length + 1, 1)}${RESET}${SHOW_CURSOR}`);
    },
  };
}

/** Clear the whole screen and home the cursor — used for the very first frame. */
export function clearScreen(out: NodeJS.WriteStream = process.stdout): void {
  out.write(`${CURSOR_HOME}${CLEAR_TO_END}`);
}
