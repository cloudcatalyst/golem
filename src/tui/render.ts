/**
 * The view: `renderPanel(state) → lines`. Pure, so the entire UI is assertable as
 * strings, with no terminal and no framework.
 *
 * This replaced ink's flexbox layer. What ink was actually doing for this panel was
 * modest — a vertical stack, one two-column row (fixed-width pet + flexible text),
 * and one space-between row for the tab bar — so the layout is computed directly
 * here. Width arithmetic is delegated to width.ts (ANSI- and wide-char-aware) and
 * colour to ansi.ts.
 */

import { CONTROL_TABS, type Control } from "../config/control-surface.js";
import { paint } from "./ansi.js";
import { formatValue, LABEL_WIDTH, scrollWindow, stateBox, VALUE_WIDTH } from "./controls.js";
import { collapseWarning, type HeaderLine, headerLines, pendingHeaderLines } from "./header.js";
import { hiddenAdvancedCount, type PanelState, selectedControl, visibleRows } from "./state.js";
import { PET_LINES, PET_WIDTH, RULE_CHAR, type Theme } from "./theme.js";
import { displayWidth, padTo, truncateTo } from "./width.js";

export interface RenderOptions {
  readonly theme: Theme;
  readonly showPet: boolean;
  readonly width: number;
  readonly height: number;
}

/** Columns the pet block occupies including its right margin. */
const PET_COLUMN = PET_WIDTH + 4;
/** One column of left padding, matching the old ink `paddingX={1}`. */
const GUTTER = " ";

/**
 * Render the whole panel. The returned array is exactly the lines to print, each
 * already clipped to `width`; the caller diffs them against the previous frame.
 */
export function renderPanel(state: PanelState, options: RenderOptions): readonly string[] {
  const { theme, width } = options;
  const inner = Math.max(20, width - 2);
  const lines: string[] = [];

  lines.push(...renderHeader(state, options, inner));
  lines.push(rule(theme, inner));
  lines.push(renderTabs(state, theme, inner));
  lines.push(rule(theme, inner));

  // Whatever is left after the chrome above and the footer below.
  const used = lines.length + 3; // + rule + footer + detail
  const listHeight = Math.max(3, options.height - used - 3);
  lines.push(...renderList(state, theme, inner, listHeight));
  lines.push(...renderDetail(state, theme, inner));
  lines.push(rule(theme, inner));
  lines.push(...renderFooter(state, theme, inner));

  return lines.map((line) => `${GUTTER}${truncateTo(line, inner)}`);
}

function rule(theme: Theme, width: number): string {
  return paint(RULE_CHAR.repeat(width), theme.dim, theme.level);
}

/** The pet on the left, the three info lines on the right, warnings underneath. */
function renderHeader(state: PanelState, options: RenderOptions, width: number): readonly string[] {
  const { theme, showPet } = options;
  const report = state.surface.header;
  const info: readonly HeaderLine[] =
    report !== null ? headerLines(report) : pendingHeaderLines(state.version, state.projectDir);

  const textWidth = width - (showPet ? PET_COLUMN : 0);
  const out: string[] = [];
  for (let i = 0; i < PET_LINES.length; i += 1) {
    // The pet column is a FIXED width: U+25A0 is Ambiguous-width, so a
    // CJK-configured terminal may draw it double. Reserving the columns means that
    // shifts the glyph, never the text beside it.
    const pet = showPet
      ? padTo(paint(PET_LINES[i] ?? "", theme.pet, theme.level, { bold: true }), PET_COLUMN)
      : "";
    out.push(`${pet}${renderHeaderLine(info[i] ?? [], theme, textWidth)}`);
  }

  if (report !== null && report.warnings.length > 0) {
    out.push("");
    for (const warning of report.warnings) {
      out.push(paint(`! ${collapseWarning(warning, width - 3)}`, theme.warn, theme.level));
    }
  }
  return out;
}

function renderHeaderLine(line: HeaderLine, theme: Theme, width: number): string {
  const parts = line.map((segment) => {
    const label = paint(`${segment.label} `, theme.dim, theme.level);
    const colour = toneColour(segment.tone, theme);
    return `${label}${paint(segment.value, colour, theme.level)}`;
  });
  return truncateTo(parts.join("   "), Math.max(10, width));
}

function toneColour(tone: HeaderSegmentTone, theme: Theme): string | undefined {
  switch (tone) {
    case "ok":
      return theme.ok;
    case "warn":
      return theme.warn;
    case "error":
      return theme.error;
    default:
      return undefined;
  }
}

type HeaderSegmentTone = HeaderLine[number]["tone"];

/** The tab bar, with the active write scope pushed to the right edge. */
function renderTabs(state: PanelState, theme: Theme, width: number): string {
  const control = selectedControl(state);
  const scopes = control?.writableScopes ?? [];
  const scope = scopes.includes(state.scope) ? state.scope : scopes[0];

  const tabs = CONTROL_TABS.map((tab) => {
    const active = tab.id === state.tab;
    const text = `  ${active ? tab.title.toUpperCase() : tab.title}  `;
    return paint(text, active ? theme.accent : theme.dim, theme.level, { bold: active });
  }).join("");

  const right =
    scope === undefined
      ? paint("read-only", theme.dim, theme.level)
      : `${paint("scope: ", theme.dim, theme.level)}${paint(scope, theme.accent, theme.level)}`;

  const gap = Math.max(1, width - displayWidth(tabs) - displayWidth(right));
  return `${tabs}${" ".repeat(gap)}${right}`;
}

/** Group headings and control rows, scrolled to keep the cursor visible. */
function renderList(
  state: PanelState,
  theme: Theme,
  width: number,
  height: number,
): readonly string[] {
  const rows = visibleRows(state);
  const { start, end } = scrollWindow(state.cursor, rows.length, height);
  const out: string[] = [];

  if (start > 0) out.push(paint(`  ↑ ${start} more`, theme.dim, theme.level));

  for (let index = start; index < end; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    if (row.kind === "group") {
      if (index !== start) out.push("");
      const title = paint(row.group.title, theme.accent, theme.level, { bold: true });
      const summary =
        row.group.summary !== undefined
          ? paint(` — ${row.group.summary}`, theme.dim, theme.level)
          : "";
      out.push(truncateTo(`${title}${summary}`, width));
      continue;
    }

    const control = row.control;
    const selected = index === state.cursor;
    const editing = state.mode.kind === "edit" ? state.mode : null;

    if (selected && editing !== null && editing.controlId === control.id) {
      out.push(
        `${paint("▸ ", theme.accent, theme.level)}${padTo(control.label, LABEL_WIDTH)} ` +
          paint(`${editing.draft}▏`, theme.accent, theme.level),
      );
      continue;
    }

    const cursor = paint(selected ? "▸ " : "  ", selected ? theme.accent : undefined, theme.level);
    const box = paint(
      stateBox(control),
      control.locked !== undefined ? theme.dim : undefined,
      theme.level,
    );
    const label = paint(
      ` ${padTo(control.label, LABEL_WIDTH)}`,
      selected ? theme.accent : undefined,
      theme.level,
      { bold: selected },
    );
    const value = paint(
      ` ${padTo(formatValue(control), VALUE_WIDTH)}`,
      valueColour(control, theme),
      theme.level,
    );
    const layer = paint(
      ` ${state.busy.includes(control.id) ? "…" : control.layer}`,
      theme.dim,
      theme.level,
    );
    out.push(`${cursor}${box}${label}${value}${layer}`);
  }

  if (end < rows.length) out.push(paint(`  ↓ ${rows.length - end} more`, theme.dim, theme.level));
  return out;
}

function valueColour(control: Control, theme: Theme): string | undefined {
  if (control.locked !== undefined) return theme.dim;
  if (control.kind === "toggle") return control.value === true ? theme.ok : theme.dim;
  return undefined;
}

/** The description, lock reason, or confirm prompt for the selected control. */
function renderDetail(state: PanelState, theme: Theme, width: number): readonly string[] {
  if (state.mode.kind === "confirm") {
    const control = selectedControl(state);
    return [
      "",
      paint(
        collapseWarning(control?.danger ?? "This change is dangerous.", width),
        theme.error,
        theme.level,
        { bold: true },
      ),
      paint("Apply it? y / n", theme.warn, theme.level),
    ];
  }
  const control = selectedControl(state);
  if (control === null) return [""];
  const out = ["", paint(control.summary, theme.dim, theme.level)];
  if (control.locked !== undefined) {
    out.push(
      paint(`locked: ${collapseWarning(control.locked, width - 9)}`, theme.warn, theme.level),
    );
  } else if (control.source !== undefined) {
    out.push(paint(`from ${control.source}`, theme.dim, theme.level));
  }
  return out;
}

/** The key-hint bar, the last status message, or the help card. */
function renderFooter(state: PanelState, theme: Theme, width: number): readonly string[] {
  if (state.mode.kind === "help") {
    return [
      paint("Keys", theme.accent, theme.level, { bold: true }),
      ...HELP_LINES.map((line) => paint(line, theme.dim, theme.level)),
      paint("Press any key to close.", theme.dim, theme.level),
    ];
  }
  if (state.status !== null) {
    const colour = state.status.tone === "error" ? theme.error : theme.ok;
    return [paint(truncateTo(state.status.text, width), colour, theme.level)];
  }
  const hidden = hiddenAdvancedCount(state);
  const advanced =
    hidden > 0 ? ` · a ${hidden} advanced` : state.showAdvanced ? " · a hide advanced" : "";
  return [
    paint(
      `↑↓ move · space toggle · enter edit · s scope · tab group${advanced} · ? help · q quit`,
      theme.dim,
      theme.level,
    ),
  ];
}

const HELP_LINES: readonly string[] = [
  "  ↑↓ / j k   move                space   toggle · step an enum",
  "  ← →        step an enum        enter   edit a value (empty = unset)",
  "  s          cycle write scope   a       show/hide advanced",
  "  tab / [ ]  change tab          r       reload from disk",
  "  ?          this help           q / esc quit",
];
