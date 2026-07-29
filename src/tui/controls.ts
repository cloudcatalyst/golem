/**
 * How a single control row reads: its state box, its value, and how the list
 * scrolls. All pure — `render.ts` composes and colours these.
 */

import type { Control } from "../config/control-surface.js";

/** Columns reserved for the label, so values line up down the list. */
export const LABEL_WIDTH = 34;
/** Columns reserved for the value before the layer tag. */
export const VALUE_WIDTH = 26;

/**
 * The checkbox / affordance for a control's current state:
 *   `[x]` / `[ ]` toggles · `[·]` locked · `   ` everything else (values speak for
 * themselves, and a fake checkbox would imply it's togglable).
 */
export function stateBox(control: Control): string {
  if (control.locked !== undefined) return "[·]";
  if (control.kind === "toggle") return control.value === true ? "[x]" : "[ ]";
  return "   ";
}

/** A control's value rendered for one line of terminal text. */
export function formatValue(control: Control): string {
  const value = control.value;
  if (value === undefined || value === null) return "(unset)";
  if (control.kind === "toggle") return value === true ? "on" : "off";
  if (Array.isArray(value)) {
    if (value.length === 0) return "(none)";
    // Only a list of primitives reads as comma-separated text; a structured array
    // (the account registry) would otherwise join to "[object Object]".
    return value.every((item) => typeof item !== "object" || item === null)
      ? value.join(", ")
      : `${value.length} entr${value.length === 1 ? "y" : "ies"}`;
  }
  if (control.kind === "enum") {
    const option = control.options?.find((o) => o.value === String(value));
    return option?.label ?? String(value);
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** The whole row as plain text — what a test (or a `--plain` dump) asserts on. */
export function controlRowText(control: Control): string {
  return (
    `${stateBox(control)} ${pad(control.label, LABEL_WIDTH)} ` +
    `${pad(formatValue(control), VALUE_WIDTH)} ${control.layer}`
  );
}

/**
 * Which slice of the row list to draw so the cursor stays visible, keeping it off
 * the very edge where possible.
 */
export function scrollWindow(
  cursor: number,
  total: number,
  height: number,
): { readonly start: number; readonly end: number } {
  if (total <= height) return { start: 0, end: total };
  const half = Math.floor(height / 2);
  const start = Math.max(0, Math.min(cursor - half, total - height));
  return { start, end: start + height };
}

/**
 * ASCII-only padding for {@link controlRowText}. `render.ts` uses the width-aware
 * `padTo` from width.ts for anything that reaches the terminal; this exists so the
 * plain-text form stays trivially predictable in tests.
 */
function pad(text: string, width: number): string {
  return text.length >= width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}
