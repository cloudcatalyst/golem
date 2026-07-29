/**
 * The scrolling control list: group headings, one row per control, and the inline
 * editor / confirm prompt that replace a row while they're active.
 *
 * {@link controlRowText} is the pure text form of a row (state box, label, value,
 * layer). Tests assert on it directly; the component just colours it.
 */

import { Box, Text } from "ink";
import type { Control } from "../config/index.js";
import type { PanelState } from "./state.js";
import { selectedControl, visibleRows } from "./state.js";
import { col, type Theme } from "./theme.js";

/** Columns reserved for the label, so values line up down the list. */
const LABEL_WIDTH = 34;
/** Columns reserved for the value before the layer tag. */
const VALUE_WIDTH = 26;

/**
 * The checkbox / affordance for a control's current state:
 *   `[x]` / `[ ]` toggles · `[·]` locked · `   ` everything else (values speak
 * for themselves and a fake checkbox would imply it's togglable).
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

/** The whole row as plain text — what a test (or a `--plain` dump) can assert on. */
export function controlRowText(control: Control): string {
  return (
    `${stateBox(control)} ${pad(control.label, LABEL_WIDTH)} ` +
    `${pad(formatValue(control), VALUE_WIDTH)} ${control.layer}`
  );
}

interface ControlListProps {
  readonly state: PanelState;
  readonly theme: Theme;
  /** Max rows to draw; the list scrolls to keep the cursor visible. */
  readonly height: number;
}

export function ControlList({ state, theme, height }: ControlListProps): React.JSX.Element {
  const rows = visibleRows(state);
  const { start, end } = scrollWindow(state.cursor, rows.length, height);
  const editing = state.mode.kind === "edit" ? state.mode : null;

  return (
    <Box flexDirection="column">
      {start > 0 ? <Text color={theme.dim}>{`  ↑ ${start} more`}</Text> : null}
      {rows.slice(start, end).map((row, offset) => {
        const index = start + offset;
        if (row.kind === "group") {
          return (
            <Box key={row.group.id} marginTop={index === 0 ? 0 : 1}>
              <Text color={theme.accent} bold>
                {row.group.title}
              </Text>
              {row.group.summary !== undefined ? (
                <Text color={theme.dim}>{` — ${row.group.summary}`}</Text>
              ) : null}
            </Box>
          );
        }
        const control = row.control;
        const selected = index === state.cursor;
        if (selected && editing !== null && editing.controlId === control.id) {
          return (
            <Text key={control.id}>
              <Text color={theme.accent}>{"▸ "}</Text>
              <Text>{pad(control.label, LABEL_WIDTH)} </Text>
              <Text color={theme.accent}>{`${editing.draft}▏`}</Text>
            </Text>
          );
        }
        return (
          <Text key={control.id} wrap="truncate-end">
            <Text {...col(selected ? theme.accent : undefined)}>{selected ? "▸ " : "  "}</Text>
            <Text {...col(control.locked !== undefined ? theme.dim : undefined)}>
              {stateBox(control)}
            </Text>
            <Text bold={selected} {...col(selected ? theme.accent : undefined)}>
              {` ${pad(control.label, LABEL_WIDTH)}`}
            </Text>
            <Text {...col(valueColor(control, theme))}>
              {` ${pad(formatValue(control), VALUE_WIDTH)}`}
            </Text>
            <Text
              color={theme.dim}
            >{` ${state.busy.includes(control.id) ? "…" : control.layer}`}</Text>
          </Text>
        );
      })}
      {end < rows.length ? <Text color={theme.dim}>{`  ↓ ${rows.length - end} more`}</Text> : null}
      <Detail state={state} theme={theme} />
    </Box>
  );
}

/** The description / lock reason / confirm prompt for whatever is selected. */
function Detail({ state, theme }: { state: PanelState; theme: Theme }): React.JSX.Element | null {
  if (state.mode.kind === "confirm") {
    const control = selectedControl(state);
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.error} bold>
          {control?.danger ?? "This change is dangerous."}
        </Text>
        <Text color={theme.warn}>Apply it? y / n</Text>
      </Box>
    );
  }
  const control = selectedControl(state);
  if (control === null) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.dim} wrap="truncate-end">
        {control.summary}
      </Text>
      {control.locked !== undefined ? (
        <Text color={theme.warn} wrap="truncate-end">{`locked: ${control.locked}`}</Text>
      ) : null}
      {control.source !== undefined && control.locked === undefined ? (
        <Text color={theme.dim} wrap="truncate-end">{`from ${control.source}`}</Text>
      ) : null}
    </Box>
  );
}

function valueColor(control: Control, theme: Theme): string | undefined {
  if (control.locked !== undefined) return theme.dim;
  if (control.kind === "toggle") return control.value === true ? theme.ok : theme.dim;
  return undefined;
}

/**
 * Which slice of the row list to draw so the cursor stays visible, keeping the
 * cursor off the very edge where possible (one row of lookahead each way).
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

function pad(text: string, width: number): string {
  return text.length >= width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}
