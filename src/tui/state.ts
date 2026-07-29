/**
 * The panel's state machine — deliberately pure, and deliberately ink-free.
 *
 * Every keypress becomes a {@link PanelEvent}; {@link reducePanel} returns the next
 * {@link PanelState} plus a list of {@link PanelEffect}s for the caller to perform
 * (apply a control, reload the surface, exit). Nothing here touches the terminal,
 * the filesystem, or React — so the interaction rules (what space does on a
 * locked row, when a danger confirm is required, how the scope cycles) are unit
 * tested directly, without rendering anything.
 *
 * The rows a UI draws are also derived here ({@link visibleRows}), so tab
 * filtering, the advanced toggle, and group headers behave identically in every
 * front end.
 */

import type { StatusReport } from "../cli/status.js";
import type {
  Control,
  ControlGroup,
  ControlSurface,
  ControlTab,
} from "../config/control-surface.js";
import { CONTROL_TABS } from "../config/control-surface.js";

/** A drawable line: a group heading or a control. */
export type PanelRow =
  | { readonly kind: "group"; readonly group: ControlGroup }
  | { readonly kind: "control"; readonly control: Control; readonly group: ControlGroup };

/** What the panel is currently doing — only one of these at a time. */
export type PanelMode =
  /** Normal navigation. */
  | { readonly kind: "browse" }
  /** Typing a new value for a text/number/url/list/color control. */
  | { readonly kind: "edit"; readonly controlId: string; readonly draft: string }
  /** Confirming a change flagged {@link Control.danger}. */
  | { readonly kind: "confirm"; readonly controlId: string; readonly value: unknown }
  /** The help overlay. */
  | { readonly kind: "help" };

export interface PanelState {
  readonly surface: ControlSurface;
  readonly tab: ControlTab;
  /** Index into {@link visibleRows}; always points at a `control` row when one exists. */
  readonly cursor: number;
  /** Which scope writes land in, for controls that offer a choice. */
  readonly scope: string;
  readonly showAdvanced: boolean;
  readonly mode: PanelMode;
  /** Transient one-line message (last apply result, or an error). */
  readonly status: { readonly text: string; readonly tone: "info" | "error" } | null;
  /** Set once the user has asked to leave; the host unmounts on this. */
  readonly exiting: boolean;
  /** Ids with a write in flight — rendered as pending so double-presses are visible. */
  readonly busy: readonly string[];
}

export type PanelEvent =
  | { readonly kind: "key"; readonly key: KeyPress }
  /** A fresh surface arrived (initial load, a reload, or a file watcher firing). */
  | { readonly kind: "surface"; readonly surface: ControlSurface }
  /** The deferred info header arrived (see ControlSurface.header). */
  | { readonly kind: "header"; readonly header: StatusReport }
  | { readonly kind: "applied"; readonly controlId: string; readonly message: string }
  | { readonly kind: "failed"; readonly controlId: string; readonly message: string };

/** A decoded keypress — the subset ink's `useInput` reports that this panel uses. */
export interface KeyPress {
  readonly input: string;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly tab?: boolean;
  readonly shift?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly ctrl?: boolean;
}

export type PanelEffect =
  | {
      readonly kind: "apply";
      readonly controlId: string;
      readonly value: unknown;
      readonly scope: string;
    }
  | { readonly kind: "reload" }
  | { readonly kind: "exit" };

export interface PanelStep {
  readonly state: PanelState;
  readonly effects: readonly PanelEffect[];
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

export function initialState(
  surface: ControlSurface,
  options: { readonly showAdvanced?: boolean } = {},
): PanelState {
  const state: PanelState = {
    surface,
    tab: "settings",
    cursor: 0,
    scope: "project",
    showAdvanced: options.showAdvanced === true,
    mode: { kind: "browse" },
    status: null,
    exiting: false,
    busy: [],
  };
  // Land the cursor on the first real control rather than a group heading.
  return { ...state, cursor: nextControlIndex(state, -1, 1) };
}

/**
 * The rows for the current tab: each group's heading followed by its controls,
 * with advanced controls filtered out unless {@link PanelState.showAdvanced}.
 * A group whose controls are all filtered away is dropped entirely.
 */
export function visibleRows(state: PanelState): readonly PanelRow[] {
  const rows: PanelRow[] = [];
  for (const group of state.surface.groups) {
    if (group.tab !== state.tab) continue;
    const controls = group.controls.filter((c) => state.showAdvanced || !c.advanced);
    if (controls.length === 0) continue;
    rows.push({ kind: "group", group });
    for (const control of controls) rows.push({ kind: "control", control, group });
  }
  return rows;
}

/** The control under the cursor, or null when the tab has none. */
export function selectedControl(state: PanelState): Control | null {
  const row = visibleRows(state)[state.cursor];
  return row !== undefined && row.kind === "control" ? row.control : null;
}

/** How many advanced controls the current tab is hiding (for the footer hint). */
export function hiddenAdvancedCount(state: PanelState): number {
  if (state.showAdvanced) return 0;
  let count = 0;
  for (const group of state.surface.groups) {
    if (group.tab !== state.tab) continue;
    count += group.controls.filter((c) => c.advanced).length;
  }
  return count;
}

/**
 * Walk `step` rows from `from` and return the index of the next `control` row,
 * skipping group headings. Stops at the ends (no wrap-around: wrapping in a long
 * settings list loses the user's place more often than it helps).
 */
function nextControlIndex(state: PanelState, from: number, step: number): number {
  const rows = visibleRows(state);
  for (let i = from + step; i >= 0 && i < rows.length; i += step) {
    if (rows[i]?.kind === "control") return i;
  }
  // Nothing in that direction — keep the current position if it's valid.
  return rows[from]?.kind === "control" ? from : Math.max(0, Math.min(from, rows.length - 1));
}

// ---------------------------------------------------------------------------
// Reduce
// ---------------------------------------------------------------------------

const NO_EFFECTS: readonly PanelEffect[] = [];
const step = (state: PanelState, effects: readonly PanelEffect[] = NO_EFFECTS): PanelStep => ({
  state,
  effects,
});

export function reducePanel(state: PanelState, event: PanelEvent): PanelStep {
  switch (event.kind) {
    case "surface": {
      // Keep the cursor where it was if that row still exists; a reload from a
      // file watcher must not jump the user somewhere else mid-scroll.
      //
      // Reloads collect WITHOUT the header (it's the expensive half), so a null
      // header means "unchanged", never "gone" — otherwise every reload would blank
      // the info block for a moment.
      const surface: ControlSurface =
        event.surface.header === null && state.surface.header !== null
          ? { ...event.surface, header: state.surface.header }
          : event.surface;
      const next: PanelState = { ...state, surface };
      const rows = visibleRows(next);
      const cursor =
        rows[state.cursor]?.kind === "control" ? state.cursor : nextControlIndex(next, -1, 1);
      return step({ ...next, cursor, busy: [] });
    }
    case "header":
      // Slots the deferred header in without disturbing the cursor, the mode, or
      // anything the user has done in the meantime.
      return step({
        ...state,
        surface: { ...state.surface, header: event.header, warnings: event.header.warnings },
      });
    case "applied":
      return step({
        ...state,
        busy: state.busy.filter((id) => id !== event.controlId),
        status: { text: event.message, tone: "info" },
      });
    case "failed":
      return step({
        ...state,
        busy: state.busy.filter((id) => id !== event.controlId),
        status: { text: event.message, tone: "error" },
      });
    case "key":
      return reduceKey(state, event.key);
  }
}

function reduceKey(state: PanelState, key: KeyPress): PanelStep {
  switch (state.mode.kind) {
    case "edit":
      return reduceEditKey(state, key, state.mode);
    case "confirm":
      return reduceConfirmKey(state, key, state.mode);
    case "help":
      // Any key closes help — it's a reference card, not a mode to get stuck in.
      return step({ ...state, mode: { kind: "browse" } });
    case "browse":
      return reduceBrowseKey(state, key);
  }
}

function reduceBrowseKey(state: PanelState, key: KeyPress): PanelStep {
  // Ctrl-C and q always leave, from anywhere in browse mode.
  if (key.escape || (key.ctrl && key.input === "c") || key.input === "q") {
    return step({ ...state, exiting: true }, [{ kind: "exit" }]);
  }
  if (key.input === "?") return step({ ...state, mode: { kind: "help" } });
  if (key.input === "r") return step({ ...state, status: null }, [{ kind: "reload" }]);

  if (key.upArrow || key.input === "k") {
    return step({ ...state, cursor: nextControlIndex(state, state.cursor, -1) });
  }
  if (key.downArrow || key.input === "j") {
    return step({ ...state, cursor: nextControlIndex(state, state.cursor, 1) });
  }
  if (key.tab || key.input === "]") return step(switchTab(state, key.shift === true ? -1 : 1));
  if (key.input === "[") return step(switchTab(state, -1));

  if (key.input === "a") {
    const next: PanelState = { ...state, showAdvanced: !state.showAdvanced };
    // The row list just changed shape; re-anchor rather than point at a heading.
    return step({ ...next, cursor: nextControlIndex(next, -1, 1) });
  }

  const control = selectedControl(state);
  if (control === null) return step(state);

  if (key.input === "s") return step(cycleScope(state, control));

  // Space / enter / arrows act on the selected control.
  if (key.input === " ") return activate(state, control);
  if (key.return) return activate(state, control, { edit: true });
  if (key.leftArrow || key.rightArrow) {
    if (control.kind !== "enum") return step(state);
    return applyEnumStep(state, control, key.rightArrow === true ? 1 : -1);
  }
  return step(state);
}

/**
 * Space (and enter) on a control: flip a toggle, step an enum, or open the text
 * editor. `edit: true` (enter) prefers the editor for enums too, but enums have
 * no free-text form, so it steps them instead.
 */
function activate(
  state: PanelState,
  control: Control,
  options: { readonly edit?: boolean } = {},
): PanelStep {
  if (control.locked !== undefined) {
    return step({
      ...state,
      status: { text: `${control.label}: ${control.locked}`, tone: "error" },
    });
  }
  switch (control.kind) {
    case "toggle":
      return requestApply(state, control, !truthy(control.value));
    case "enum":
      return applyEnumStep(state, control, 1);
    case "opaque":
      return step({
        ...state,
        status: { text: `${control.label} is not editable here`, tone: "error" },
      });
    default:
      return step({
        ...state,
        status: null,
        mode: {
          kind: "edit",
          controlId: control.id,
          draft: options.edit === false ? "" : formatForEdit(control.value),
        },
      });
  }
}

/** Move an enum control `delta` places through its options and apply the result. */
function applyEnumStep(state: PanelState, control: Control, delta: number): PanelStep {
  if (control.locked !== undefined) {
    return step({
      ...state,
      status: { text: `${control.label}: ${control.locked}`, tone: "error" },
    });
  }
  const options = control.options ?? [];
  if (options.length === 0) return step(state);
  const current = options.findIndex((o) => o.value === String(control.value));
  // Enums DO wrap: the list is short and cycling is the expected affordance.
  const nextIndex =
    ((((current === -1 ? 0 : current) + delta) % options.length) + options.length) % options.length;
  const nextValue = options[nextIndex]?.value;
  if (nextValue === undefined) return step(state);
  return requestApply(state, control, nextValue);
}

/**
 * Queue a write — or, when the control carries a {@link Control.danger} warning
 * and the new value isn't the safe one, ask for confirmation first.
 */
function requestApply(state: PanelState, control: Control, value: unknown): PanelStep {
  if (control.danger !== undefined && needsConfirm(control, value)) {
    return step({
      ...state,
      status: null,
      mode: { kind: "confirm", controlId: control.id, value },
    });
  }
  return step({ ...state, status: null, busy: [...state.busy, control.id] }, [
    { kind: "apply", controlId: control.id, value, scope: effectiveScope(state, control) },
  ]);
}

/**
 * Which value of a dangerous control actually needs the confirm. Only the risky
 * setting does — turning redaction back ON should never prompt.
 *
 * Slider level 0 is the passthrough bypass (Decision 30); every other level is
 * safe. For a dangerous toggle, enabling it is the risky direction.
 */
function needsConfirm(control: Control, value: unknown): boolean {
  if (control.kind === "enum") return String(value) === "0";
  return truthy(value);
}

function switchTab(state: PanelState, delta: number): PanelState {
  const index = CONTROL_TABS.findIndex((t) => t.id === state.tab);
  const nextIndex =
    (((index + delta) % CONTROL_TABS.length) + CONTROL_TABS.length) % CONTROL_TABS.length;
  const tab = CONTROL_TABS[nextIndex]?.id ?? state.tab;
  const next: PanelState = { ...state, tab, status: null };
  return { ...next, cursor: nextControlIndex(next, -1, 1) };
}

/** Cycle the write scope through the selected control's own allowed scopes. */
function cycleScope(state: PanelState, control: Control): PanelState {
  const scopes = control.writableScopes;
  if (scopes.length <= 1) {
    return {
      ...state,
      status: {
        text:
          scopes.length === 1
            ? `${control.label} always writes ${scopes[0]} scope`
            : `${control.label} is not writable`,
        tone: "info",
      },
    };
  }
  const index = scopes.indexOf(state.scope);
  const scope = scopes[(index + 1) % scopes.length] ?? scopes[0];
  return { ...state, scope: scope as string, status: null };
}

/**
 * The scope a write to `control` uses: the panel's current scope when the control
 * allows it, otherwise the control's own first (preferred) scope. This is what
 * keeps a `user`-scoped session from trying to write `user` to the slider, which
 * only ever writes local scope.
 */
export function effectiveScope(state: PanelState, control: Control): string {
  if (control.writableScopes.includes(state.scope)) return state.scope;
  return control.writableScopes[0] ?? state.scope;
}

function reduceEditKey(
  state: PanelState,
  key: KeyPress,
  mode: Extract<PanelMode, { kind: "edit" }>,
): PanelStep {
  if (key.escape || (key.ctrl && key.input === "c")) {
    return step({ ...state, mode: { kind: "browse" } });
  }
  if (key.return) {
    const control = findControl(state, mode.controlId);
    if (control === null) return step({ ...state, mode: { kind: "browse" } });
    const trimmed = mode.draft.trim();
    // An emptied field means "unset this key" — the panel's way of reverting to
    // whatever lower layer or default was there before.
    const value = trimmed === "" ? null : trimmed;
    const browsing: PanelState = { ...state, mode: { kind: "browse" } };
    return requestApply(browsing, control, value);
  }
  if (key.backspace || key.delete) {
    return step({ ...state, mode: { ...mode, draft: mode.draft.slice(0, -1) } });
  }
  // Printable input only; arrow keys and other escape sequences must not end up
  // inside the value being typed.
  if (key.input.length > 0 && !key.ctrl && isPrintable(key.input)) {
    return step({ ...state, mode: { ...mode, draft: mode.draft + key.input } });
  }
  return step(state);
}

function reduceConfirmKey(
  state: PanelState,
  key: KeyPress,
  mode: Extract<PanelMode, { kind: "confirm" }>,
): PanelStep {
  const lowered = key.input.toLowerCase();
  if (lowered === "y") {
    const control = findControl(state, mode.controlId);
    if (control === null) return step({ ...state, mode: { kind: "browse" } });
    return step(
      {
        ...state,
        mode: { kind: "browse" },
        status: null,
        busy: [...state.busy, control.id],
      },
      [
        {
          kind: "apply",
          controlId: control.id,
          value: mode.value,
          scope: effectiveScope(state, control),
        },
      ],
    );
  }
  // Anything other than an explicit yes cancels — a dangerous change should
  // never be one stray keypress away.
  if (lowered === "n" || key.escape || key.return || key.input === " ") {
    return step({
      ...state,
      mode: { kind: "browse" },
      status: { text: "cancelled", tone: "info" },
    });
  }
  return step(state);
}

function findControl(state: PanelState, id: string): Control | null {
  for (const group of state.surface.groups) {
    for (const control of group.controls) {
      if (control.id === id) return control;
    }
  }
  return null;
}

/** Render a value into the edit buffer: lists as comma-separated, unset as empty. */
export function formatForEdit(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function truthy(value: unknown): boolean {
  return value === true || value === "true";
}

function isPrintable(input: string): boolean {
  for (const ch of input) {
    if (ch < " " || ch === "") return false;
  }
  return true;
}
